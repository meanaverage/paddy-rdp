# Shared JavaScript data values

Portable application policies share exact UTF-16 strings and tagged observations
for missing values, null, booleans, IEEE-754 numbers, arrays and objects. Text and
observation conversion were extracted unchanged from the desktop identity/policy
cores; those modules re-export the same interfaces. Their existing compatibility
suites continue to exercise the extraction.

The JSON data parser additionally supports the ECMAScript values needed by Messages:
last duplicate keys, escaped lone surrogates, negative zero and decimal overflow.
It accepts at most 8 MiB and 128 recursive nesting steps. It does not execute JavaScript,
methods or object hooks. Data-to-string conversion models JSON values only;
a non-callable own `toString` property rejects coercion as JavaScript does.

Native tests cover the JSON grammar, exact UTF-16 values and real limits. Messages
fuzzing reaches the parser with arbitrary untrusted bytes, and the Messages Wasm
comparison checks production results against the former JSON.parse-based decoder.
