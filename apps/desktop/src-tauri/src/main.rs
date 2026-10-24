// No console window behind the till in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    pos_desktop_lib::run()
}
