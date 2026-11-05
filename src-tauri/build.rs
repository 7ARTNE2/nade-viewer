fn main() {
    // Tauri watches the files it already knows about. Watch the directory too
    // so newly added bundled resources are copied on the next Cargo build.
    println!("cargo:rerun-if-changed=resources");
    tauri_build::build()
}
