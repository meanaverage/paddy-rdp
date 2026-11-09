use paddy_rdp_transfer_core::{dispatch, handle, Transfer, MAX_IN_FLIGHT, MAX_RANGE, MIN_COST};
use serde_json::{json, Value};
fn request(stream: u32, size: u32, flags: u32) -> Value {
    json!({"streamId":stream,"index":0,"flags":flags,"position":0.0,"size":size})
}
fn op(s: &mut Transfer, command: Value) -> Value {
    handle(s, command).unwrap()["value"].clone()
}
fn reserve(s: &mut Transfer, stream: u32, size: u32) -> u64 {
    op(s, json!({"op":"reserve","request":request(stream,size,2)}))
        .as_u64()
        .unwrap()
}
fn serve(s: &mut Transfer, stream: u32, reading: u64) -> u64 {
    op(
        s,
        json!({"op":"serve","request":request(stream,1,2),"reading":reading}),
    )
    .as_u64()
    .unwrap()
}

#[test]
fn wire_stream_identity_is_separate_from_provider_identity() {
    // MS-RDPECLIP 2.2.5.4 requires the response's streamId to equal its request's.
    let mut s = Transfer::new();
    let reading = reserve(&mut s, u32::MAX, 1);
    let number = serve(&mut s, u32::MAX, reading);
    assert_eq!(number, 1);
    let answer = op(&mut s, json!({"op":"answered","number":number}));
    assert_eq!(answer, json!({"streamId":u32::MAX,"reading":reading}));
    assert_eq!(
        op(&mut s, json!({"op":"answered","number":number})),
        Value::Null
    );
    assert_eq!(
        op(&mut s, json!({"op":"release","reading":reading})),
        MIN_COST
    );
    assert_eq!(
        op(&mut s, json!({"op":"release","reading":reading})),
        Value::Null
    );
}
#[test]
fn read_and_wait_budgets_preserve_fifo_and_minimum_cost() {
    // Shipped resource policy: four 16 MiB reads, then at most 256 queued ranges.
    let mut s = Transfer::new();
    let first = reserve(&mut s, 0, MAX_RANGE);
    for n in 1..4 {
        reserve(&mut s, n, MAX_RANGE);
    }
    assert_eq!(s.reserved(), MAX_IN_FLIGHT);
    for n in 4..260 {
        assert_eq!(
            op(&mut s, json!({"op":"admit","request":request(n,0,2)})),
            "queued"
        );
    }
    assert_eq!(
        op(&mut s, json!({"op":"admit","request":request(260,0,2)})),
        "full"
    );
    assert_eq!(
        op(&mut s, json!({"op":"admit","request":request(260,8,1)})),
        "read"
    );
    assert_eq!(op(&mut s, json!({"op":"take_next"})), Value::Null);
    op(&mut s, json!({"op":"release","reading":first}));
    let next = op(&mut s, json!({"op":"take_next"}));
    assert_eq!(next["request"]["streamId"], 4);
    assert_eq!(next["bytes"], MIN_COST);
    assert_eq!(
        op(&mut s, json!({"op":"admit","request":request(5,8,1)})),
        "overlap"
    );
}
#[test]
fn disk_reads_remain_charged_and_provider_reads_expire_at_the_boundary() {
    let mut s = Transfer::new();
    let disk = reserve(&mut s, 1, 1);
    let provider = reserve(&mut s, 2, 1);
    op(&mut s, json!({"op":"ready","reading":provider,"now":1000}));
    serve(&mut s, 2, provider);
    for now in [-100, 65_999] {
        assert_eq!(op(&mut s, json!({"op":"expire","now":now})), json!([]));
    }
    assert_eq!(
        op(&mut s, json!({"op":"expire","now":66_000})),
        json!([MIN_COST])
    );
    assert_eq!(op(&mut s, json!({"op":"expire","now":1e12})), json!([]));
    assert_eq!(s.reserved(), u64::from(MIN_COST));
    assert_eq!(s.snapshot()["reading"][0]["id"], disk);
    assert_eq!(s.snapshot()["served"], json!({}));
}
#[test]
fn replaced_offer_keeps_pending_disk_charge_until_settlement() {
    let mut s = Transfer::new();
    let disk = reserve(&mut s, 1, 100);
    let provider = reserve(&mut s, 2, 100);
    op(&mut s, json!({"op":"ready","reading":provider,"now":0}));
    let n = serve(&mut s, 2, provider);
    op(&mut s, json!({"op":"admit","request":request(3,100,2)}));
    assert_eq!(
        op(&mut s, json!({"op":"next_served","after":0})),
        json!({"number":n,"streamId":2})
    );
    op(&mut s, json!({"op":"clear_served"}));
    assert_eq!(
        op(&mut s, json!({"op":"drop_reading","ready_only":true})),
        json!([MIN_COST])
    );
    assert_eq!(
        op(&mut s, json!({"op":"drain_waiting"})),
        json!([request(3, 100, 2)])
    );
    assert_eq!(op(&mut s, json!({"op":"answered","number":n})), Value::Null);
    assert_eq!(s.reserved(), u64::from(MIN_COST));
    op(&mut s, json!({"op":"ready","reading":disk,"now":1}));
    assert_eq!(op(&mut s, json!({"op":"release","reading":disk})), MIN_COST);
    assert_eq!(s.reserved(), 0);
}
#[test]
fn expired_response_cannot_claim_a_reused_remote_stream() {
    let mut s = Transfer::new();
    let a = reserve(&mut s, 7, 1);
    op(&mut s, json!({"op":"ready","reading":a,"now":0}));
    let old = serve(&mut s, 7, a);
    op(&mut s, json!({"op":"expire","now":65_000}));
    let b = reserve(&mut s, 7, 1);
    let current = serve(&mut s, 7, b);
    assert!(current > old);
    assert_eq!(
        op(&mut s, json!({"op":"answered","number":old})),
        Value::Null
    );
    assert_eq!(op(&mut s, json!({"op":"contains","number":current})), true);
    assert_eq!(s.reserved(), u64::from(MIN_COST));
}
#[test]
fn disposal_refunds_once_and_late_wake_or_answer_cannot_restart_work() {
    let mut s = Transfer::new();
    let r = reserve(&mut s, 1, 1);
    let n = serve(&mut s, 1, r);
    assert_eq!(op(&mut s, json!({"op":"await_room"})), true);
    assert_eq!(op(&mut s, json!({"op":"await_room"})), false);
    assert_eq!(op(&mut s, json!({"op":"dispose"})), json!([MIN_COST]));
    assert_eq!(op(&mut s, json!({"op":"dispose"})), json!([]));
    op(&mut s, json!({"op":"room_ready"}));
    assert_eq!(s.snapshot()["roomAwaited"], false);
    assert_eq!(op(&mut s, json!({"op":"answered","number":n})), Value::Null);
    assert!(handle(&mut s, json!({"op":"admit","request":request(2,1,2)})).is_err());
}
#[test]
fn invalid_observations_do_not_mutate_state_and_real_request_limit_is_enforced() {
    let mut s = Transfer::new();
    let before = s.snapshot();
    for bytes in [
        b"{".as_slice(),
        b"\xff",
        br#"{"op":"admit","request":{"streamId":-1,"index":0,"flags":2,"position":0.0,"size":1}}"#,
    ] {
        assert!(dispatch(&mut s, bytes).is_err());
        assert_eq!(s.snapshot(), before);
    }
    let prefix = br#"{"op":"waiting","future":""#;
    let mut boundary = prefix.to_vec();
    boundary.resize((8 << 20) - 2, b'x');
    boundary.extend_from_slice(b"\"}");
    assert!(dispatch(&mut s, &boundary).is_ok());
    boundary.push(b' ');
    assert!(dispatch(&mut s, &boundary).is_err());
    let mut request = request(0, 1, 2);
    request["index"] = json!(-1);
    assert_eq!(
        op(&mut s, json!({"op":"admit","request":request})),
        "queued"
    );
}
