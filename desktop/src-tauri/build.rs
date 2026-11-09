fn main() {
    println!("cargo:rerun-if-changed=windows-app-manifest.rc");
    println!("cargo:rerun-if-changed=windows-app-manifest.xml");
    let attributes = tauri_build::Attributes::new()
        .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    tauri_build::try_build(attributes).expect("Tauri resource build failed");
    embed_resource::compile_for_everything("windows-app-manifest.rc", embed_resource::NONE)
        .manifest_required()
        .expect("Windows manifest resource build failed");
}
