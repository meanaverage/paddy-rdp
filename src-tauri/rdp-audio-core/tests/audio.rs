use paddy_rdp_audio_core::{capture_packet, Engine, Error, Resampler, MAX_INPUT};

#[test]
fn volume_clamps_finite_levels_and_normalizes_negative_zero() {
    use paddy_rdp_audio_core::volume;
    assert_eq!(volume(-0.0).unwrap().to_bits(), 0.0f64.to_bits());
    assert_eq!(volume(-1.0), Ok(0.0));
    assert_eq!(volume(2.0), Ok(1.0));
    assert_eq!(volume(0.25), Ok(0.25));
    assert_eq!(volume(f64::NAN), Err(Error::Format));
}
fn packet(channels: &[&[f32]]) -> Vec<u8> {
    let mut out = (channels.len() as u32).to_le_bytes().to_vec();
    for channel in channels {
        out.extend_from_slice(&(channel.len() as u32).to_le_bytes());
        for sample in *channel {
            out.extend_from_slice(&sample.to_le_bytes());
        }
    }
    out
}
#[test]
fn pcm_layout_is_signed_little_endian_interleaved_input_and_planar_output() {
    // Independent PCM endpoints and channel order, not an encode/decode round trip.
    let mut e = Engine::default();
    let bytes = [0x00, 0x80, 0xff, 0x7f, 0x00, 0x00, 0xff, 0xff];
    let output = e.playback(&bytes, 2).unwrap();
    let samples: Vec<_> = output
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
        .collect();
    assert_eq!(samples, [-1.0, 0.0, 32767.0 / 32768.0, -1.0 / 32768.0]);
    assert_eq!(e.peak, 1.0);
    assert_eq!(e.playback(&[0, 0, 0xff], 1).unwrap(), 0f32.to_le_bytes());
}
#[test]
fn interpolation_retains_last_sample_and_rounds_half_toward_positive_infinity() {
    let mut r = Resampler::new(48000.0, 48000.0, 1).unwrap();
    assert_eq!(
        r.process(&[vec![-1.0, -0.5, 0.0, 0.5, 1.0]]).unwrap(),
        [-32767, -16383, 0, 16384]
    );
    assert_eq!(r.process(&[vec![-1.0, 0.0]]).unwrap(), [32767, -32767]);
}
#[test]
fn interpolation_mixes_channels_and_duplicates_mono_without_changing_time() {
    let mut mono = Resampler::new(2.0, 4.0, 1).unwrap();
    assert_eq!(
        mono.process(&[vec![-1.0, 1.0, 0.0], vec![1.0, -1.0, 0.0]])
            .unwrap(),
        [0, 0, 0, 0]
    );
    let mut stereo = Resampler::new(2.0, 4.0, 2).unwrap();
    assert_eq!(
        stereo.process(&[vec![0.0, 1.0, 0.0]]).unwrap(),
        [0, 0, 16384, 16384, 32767, 32767, 16384, 16384]
    );
}
#[test]
fn capture_formats_reset_phase_but_preserve_observed_peak_and_sent_time() {
    let mut e = Engine::default();
    let bytes = packet(&[&[1.0, 1.0, 1.0]]);
    assert_eq!(e.capture(&bytes, 2.0, 2.0, 1).unwrap().len(), 4);
    e.capture_sent(2, 1, 2.0).unwrap();
    e.reset_capture();
    assert_eq!(e.capture(&bytes, 2.0, 2.0, 1).unwrap().len(), 4);
    assert_eq!(e.sent, 1.0);
    assert_eq!(e.peak, 32767.0 / 32768.0);
    assert_eq!(e.capture(&bytes, 2.0, 4.0, 2).unwrap().len(), 16);
}
#[test]
fn local_playback_clock_preserves_lead_and_inclusive_ahead_boundary() {
    // Existing local jitter policy: 80 ms lead, skip only beyond 500 ms ahead.
    let mut e = Engine::default();
    assert_eq!(e.schedule(0.0).unwrap(), 0.0);
    assert_eq!(e.schedule(1.0).unwrap(), 1.08);
    e.played(0.02).unwrap();
    assert_eq!(e.next, 1.1);
    assert_eq!(e.received, 0.02);
    e.next = 0.5;
    assert_eq!(e.schedule(0.0).unwrap(), 0.5);
    e.next = 0.5000001;
    assert_eq!(e.schedule(0.0).unwrap(), 0.08);
    assert!(e.played(f64::INFINITY).is_err());
    assert_eq!(e.received, 0.02);
}
#[test]
fn malformed_packets_and_output_expansion_are_bounded_without_losing_prior_phase() {
    for bytes in [
        vec![],
        vec![1, 0, 0],
        vec![1, 0, 0, 0, 1, 0, 0, 0],
        vec![33, 0, 0, 0],
    ] {
        assert!(capture_packet(&bytes).is_err());
    }
    let mut e = Engine::default();
    let bytes = packet(&[&[0.0, 1.0, 0.0]]);
    e.capture(&bytes, 2.0, 2.0, 1).unwrap();
    assert_eq!(e.capture(&bytes, 1.0, 1e10, 1), Err(Error::Output));
    assert_eq!(e.capture(&bytes, 2.0, 2.0, 1).unwrap().len(), 6);
    let mut limit = vec![0; MAX_INPUT];
    limit[..4].copy_from_slice(&1u32.to_le_bytes());
    limit[4..8].copy_from_slice(&(((MAX_INPUT - 8) / 4) as u32).to_le_bytes());
    assert!(capture_packet(&limit).is_ok());
    limit.push(0);
    assert_eq!(capture_packet(&limit), Err(Error::Input));
}
#[test]
fn nonfinite_samples_keep_typed_array_conversion_and_invalid_rates_are_refused() {
    let mut r = Resampler::new(1.0, 1.0, 1).unwrap();
    assert_eq!(
        r.process(&[vec![f32::NAN, f32::INFINITY, f32::NEG_INFINITY, 0.0]])
            .unwrap(),
        [0, 0, 0]
    );
    for rate in [0.0, -1.0, f64::NAN, f64::INFINITY] {
        assert!(Resampler::new(48000.0, rate, 1).is_err());
    }
    assert!(Engine::default()
        .capture_sent(usize::MAX, 1, f64::MIN_POSITIVE)
        .is_err());
}

#[test]
fn shorter_channel_keeps_a_missing_tail_sample_across_blocks() {
    // The first channel sets the block length. JS reads undefined at the missing
    // tail, then interpolation produces NaN and the destination Int16Array zero.
    let mut r = Resampler::new(1.0, 1.0, 2).unwrap();
    assert_eq!(r.process(&[vec![0.0, 0.0], vec![0.25]]).unwrap(), [0, 0]);
    assert_eq!(
        r.process(&[vec![0.0, 0.0], vec![0.0, 0.0]]).unwrap(),
        [0, 0, 0, 0]
    );
}
