mod build_profile;

fn main() {
    println!("cargo:rerun-if-env-changed=VITE_OPENIDEA_PROFILE");
    println!("cargo:rerun-if-changed=build_profile.rs");
    println!("cargo:rustc-check-cfg=cfg(openidea_v0)");
    if build_profile::profile(std::env::var("VITE_OPENIDEA_PROFILE").ok().as_deref()) == "v0" {
        println!("cargo:rustc-cfg=openidea_v0");
    }
}
