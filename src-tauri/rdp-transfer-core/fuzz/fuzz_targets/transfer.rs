#![no_main]
use libfuzzer_sys::fuzz_target;
use paddy_rdp_transfer_core::{dispatch, handle, Transfer};
use serde_json::json;
fuzz_target!(|bytes: &[u8]| {
    let mut state=Transfer::new();
    // No length or malformed-input filter before the real 8 MiB request boundary.
    let _=dispatch(&mut state,bytes);
    // Independent generated event sequences have a separate bounded length.
    for chunk in bytes.chunks(16).take(256) {
        let byte=|n:usize| u64::from(*chunk.get(n).unwrap_or(&0));
        let request=json!({"streamId":byte(1),"index":byte(2),"flags":byte(3),"position":byte(4)*65536,"size":(byte(5)*65536+byte(6))*1024});
        let snapshot=state.snapshot();
        let reads=snapshot["reading"].as_array().unwrap();
        let id=reads.get(byte(7) as usize % reads.len().max(1)).map(|r|r["id"].as_u64().unwrap()).unwrap_or(1);
        let number=snapshot["numbered"].as_u64().unwrap().saturating_sub(byte(8));
        let operation=match byte(0)%15 {
            0=>json!({"op":"admit","request":request}),
            1=>json!({"op":"reserve","request":request}),
            2=>json!({"op":"take_next"}),
            3=>json!({"op":"ready","reading":id,"now":byte(9)*1000}),
            4=>json!({"op":"serve","request":request,"reading":id}),
            5=>json!({"op":"answered","number":number}),
            6=>json!({"op":"release","reading":id}),
            7=>json!({"op":"expire","now":byte(10)*1000}),
            8=>json!({"op":"drop_reading","ready_only":byte(11)%2==0}),
            9=>json!({"op":"clear_served"}),
            10=>json!({"op":"drain_waiting"}),
            11=>json!({"op":"await_room"}),
            12=>json!({"op":"room_ready"}),
            13=>json!({"op":"serve","request":request,"reading":null}),
            _=>json!({"op":"dispose"}),
        };
        let _=handle(&mut state,operation);
        let snapshot=state.snapshot();
        assert!(snapshot["waiting"].as_array().unwrap().len()<=256);
        assert!(snapshot["reading"].as_array().unwrap().len()<=1024);
        assert!(snapshot["served"].as_object().unwrap().len()<=1025);
        assert!(state.reserved()<=64*1024*1024);
        if snapshot["closed"]==true {
            assert_eq!(state.reserved(),0);
            assert!(snapshot["served"].as_object().unwrap().is_empty());
            // A different owner has a different state instance, as the page adapter does.
            state=Transfer::new();
        }
    }
});
