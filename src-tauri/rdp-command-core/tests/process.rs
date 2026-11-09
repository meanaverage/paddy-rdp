//! Harness-free integration runner doubles as a portable synthetic child process.
use paddy_rdp_command_core::{process, MAX_OUTPUT, OVERFLOW, TIMEOUT};
use std::io::{Read, Write};
use std::time::Duration;

fn child(args: &[String]) {
    match args[0].as_str() {
        "echo" => {
            std::io::copy(&mut std::io::stdin(), &mut std::io::stdout()).unwrap();
        }
        "count" => {
            let n: usize = args[1].parse().unwrap();
            std::io::stdout().write_all(&vec![b'x'; n]).unwrap();
        }
        "status" => {
            eprint!("{}permission denied", "x".repeat(10000));
            print!("answer");
            std::process::exit(args[1].parse().unwrap());
        }
        "early" => {
            std::process::exit(255);
        }
        "delayed" => {
            std::fs::write(&args[1], b"started").unwrap();
            std::thread::sleep(Duration::from_millis(600));
            std::fs::write(&args[2], b"finished").unwrap();
        }
        "duplex" => {
            // Output fills a pipe before stdin is read: sequential write-then-read would deadlock.
            std::io::stdout()
                .write_all(&vec![b'x'; 512 * 1024])
                .unwrap();
            let mut input = Vec::new();
            std::io::stdin().read_to_end(&mut input).unwrap();
            std::io::stdout().write_all(&input).unwrap();
        }
        _ => panic!("unknown synthetic child"),
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).is_some_and(|a| a == "--child") {
        child(&args[2..]);
        return;
    }
    let exe = std::env::current_exe()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let argv = |args: &[&str]| -> Vec<String> {
        std::iter::once("--child")
            .chain(args.iter().copied())
            .map(String::from)
            .collect()
    };
    let within = Duration::from_secs(10);
    let input = "α😀\n".repeat(20000).into_bytes();
    assert_eq!(
        process(&exe, &argv(&["echo"]), &input, within)
            .await
            .unwrap()
            .output
            .as_bytes(),
        input
    );
    let duplex = process(&exe, &argv(&["duplex"]), &input, within)
        .await
        .unwrap();
    assert_eq!(&duplex.output.as_bytes()[512 * 1024..], input);
    assert_eq!(
        process(
            &exe,
            &argv(&["count", &MAX_OUTPUT.to_string()]),
            &[],
            within
        )
        .await
        .unwrap()
        .output
        .len(),
        MAX_OUTPUT
    );
    assert_eq!(
        process(
            &exe,
            &argv(&["count", &(MAX_OUTPUT + 1).to_string()]),
            &[],
            within
        )
        .await
        .unwrap_err(),
        OVERFLOW
    );
    for code in [0, 1, 42, 255] {
        let got = process(&exe, &argv(&["status", &code.to_string()]), &[], within)
            .await
            .unwrap();
        assert_eq!(got.code, Some(code));
        assert_eq!(got.output, "answer");
        assert_eq!(got.stderr.len(), 4096);
        assert!(String::from_utf16(&got.stderr)
            .unwrap()
            .ends_with("permission denied"));
    }
    assert_eq!(
        process(
            &exe,
            &argv(&["early"]),
            &vec![b'x'; 2 * 1024 * 1024],
            within
        )
        .await
        .unwrap()
        .code,
        Some(255)
    );
    let directory = std::env::temp_dir().join(format!("paddy-command-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    for cancel in [false, true] {
        let began = directory.join(if cancel {
            "cancel-started"
        } else {
            "timeout-started"
        });
        let ended = directory.join(if cancel {
            "cancel-finished"
        } else {
            "timeout-finished"
        });
        let exe = exe.clone();
        let args = argv(&[
            "delayed",
            &began.to_string_lossy(),
            &ended.to_string_lossy(),
        ]);
        let task = tokio::spawn(async move {
            process(
                &exe,
                &args,
                &[],
                if cancel {
                    within
                } else {
                    Duration::from_millis(300)
                },
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(5), async {
            while !began.exists() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("child actually started");
        if cancel {
            task.abort();
            assert!(task.await.unwrap_err().is_cancelled());
        } else {
            assert_eq!(task.await.unwrap().unwrap_err(), TIMEOUT);
        }
        tokio::time::sleep(Duration::from_millis(700)).await;
        assert!(
            !ended.exists(),
            "the owned child continued after timeout/cancellation"
        );
        std::fs::remove_file(began).unwrap();
    }
    std::fs::remove_dir(directory).unwrap();
    println!("11 subprocess checks passed: input/output concurrency, bounds, exit codes, EPIPE, timeout and cancellation");
}
