#![no_main]
use libfuzzer_sys::fuzz_target;
use paddy_rdp_audio_core::{Engine, MAX_OUTPUT};
fuzz_target!(|bytes: &[u8]| {
    let mut e = Engine::default();
    // Raw bytes reach both public conversions with their real inclusive 8 MiB bound.
    for result in [e.capture(bytes, 48000.0, 44100.0, 2), e.playback(bytes, 2)] {
        if let Ok(output) = result { assert!(output.len() <= MAX_OUTPUT); }
    }
    // Generated streaming sequences are independently bounded, never a filter on raw input.
    for chunk in bytes.chunks(16).take(128) {
        let byte = |i:usize| *chunk.get(i).unwrap_or(&0);
        let mut bits = [0;8];
        for (i,b) in chunk.iter().take(8).enumerate() {bits[i] = *b;}
        let number = f64::from_le_bytes(bits);
        if let Ok(level) = paddy_rdp_audio_core::volume(number) { assert!((0.0..=1.0).contains(&level)); }
        match byte(0)%6 {
            0 => { let _ = e.schedule(number); },
            1 => { let _ = e.played(number); },
            2 => { let _ = e.capture_sent(byte(1) as usize, usize::from(byte(2)%2+1), number); },
            3 => { e.reset_capture(); },
            4 => { e.next = 0.0; },
            _ => {
                let count=usize::from(byte(1)%4+1);
                let frames=usize::from(byte(2));
                let mut packet=(count as u32).to_le_bytes().to_vec();
                for c in 0..count {
                    packet.extend_from_slice(&(frames as u32).to_le_bytes());
                    for n in 0..frames { packet.extend_from_slice(&[byte(n%16),byte((n+1)%16),byte((n+2+c)%16),byte((n+3)%16)]); }
                }
                let _=e.capture(&packet, [8000.0,44100.0,48000.0][byte(3) as usize%3], [8000.0,16000.0,44100.0][byte(4) as usize%3], usize::from(byte(5)%2+1));
            }
        }
        assert!(e.peak.is_finite() && (0.0..=1.0).contains(&e.peak));
        assert!(e.next.is_finite() && e.sent.is_finite() && e.received.is_finite());
    }
});
