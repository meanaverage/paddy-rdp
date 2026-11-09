//! A bounded JSON boundary for pure Rust libraries embedded in the app page as WebAssembly.
//! The page owns input allocations; output remains owned by the module until its next call.
pub const MAX_REQUEST: usize = 8 << 20;
pub const MAX_RESPONSE: usize = 16 << 20;
#[cfg(target_arch = "wasm32")]
#[macro_export]
macro_rules! export {
    ($handle:path) => {
        std::thread_local! { static OUTPUT: std::cell::RefCell<Vec<u8>> = const { std::cell::RefCell::new(Vec::new()) }; }
        #[no_mangle]
        pub extern "C" fn allocate(len: usize) -> *mut u8 {
            if len > $crate::MAX_REQUEST { return std::ptr::null_mut(); }
            Box::into_raw(vec![0u8; len].into_boxed_slice()) as *mut u8
        }
        /// The caller must supply exactly an allocation returned by allocate, once.
        #[no_mangle]
        pub unsafe extern "C" fn release(ptr: *mut u8, len: usize) {
            drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)));
        }
        /// The caller must supply a live input allocation of len bytes.
        #[no_mangle]
        pub unsafe extern "C" fn request(ptr: *const u8, len: usize) -> *const u8 {
            let result = if len > $crate::MAX_REQUEST { Err("Request is too large".into()) }
                else { serde_json::from_slice(std::slice::from_raw_parts(ptr, len)).map_err(|e| e.to_string()).and_then($handle) };
            let mut bytes = Vec::new();
            match result {
                Ok(value) => {
                    bytes.extend_from_slice(br#"{"value":"#);
                    serde_json::to_writer(&mut bytes, &value).expect("JSON response");
                    bytes.push(b'}');
                }
                Err(error) => { bytes = serde_json::to_vec(&serde_json::json!({"error":error})).expect("JSON error"); }
            }
            if bytes.len() > $crate::MAX_RESPONSE { bytes = br#"{"error":"Response is too large"}"#.to_vec(); }
            OUTPUT.with(|out| { *out.borrow_mut() = bytes; out.borrow().as_ptr() })
        }
        #[no_mangle]
        pub extern "C" fn response_len() -> usize { OUTPUT.with(|out| out.borrow().len()) }
    };
}
