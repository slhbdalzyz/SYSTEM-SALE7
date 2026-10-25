//! Installed Windows printers, written to through the spooler in RAW mode so the ESC/POS
//! bytes reach the printer untouched (the same path the vendor's "generic text" driver uses).

#[cfg(windows)]
mod imp {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Graphics::Printing::*;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe fn from_wide(p: *const u16) -> String {
        if p.is_null() {
            return String::new();
        }
        let len = (0..).take_while(|&i| *p.add(i) != 0).count();
        String::from_utf16_lossy(std::slice::from_raw_parts(p, len))
    }

    pub fn list() -> Result<Vec<String>, String> {
        let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
        let (mut needed, mut count) = (0u32, 0u32);
        unsafe {
            EnumPrintersW(flags, null(), 4, null_mut(), 0, &mut needed, &mut count);
            if needed == 0 {
                return Ok(vec![]);
            }
            let mut buf = vec![0u8; needed as usize];
            if EnumPrintersW(flags, null(), 4, buf.as_mut_ptr(), needed, &mut needed, &mut count) == 0 {
                return Err("ما قدرناش نقراو قائمة الطابعات".into());
            }
            let infos = std::slice::from_raw_parts(buf.as_ptr() as *const PRINTER_INFO_4W, count as usize);
            Ok(infos.iter().map(|i| from_wide(i.pPrinterName)).collect())
        }
    }

    pub fn write_raw(printer: &str, data: &[u8]) -> Result<(), String> {
        let name = wide(printer);
        let doc = wide("POS receipt");
        let raw = wide("RAW");
        unsafe {
            let mut h: HANDLE = null_mut();
            if OpenPrinterW(name.as_ptr(), &mut h, null()) == 0 {
                return Err(format!("الطابعة «{printer}» مش موجودة"));
            }
            let info = DOC_INFO_1W { pDocName: doc.as_ptr() as *mut _, pOutputFile: null_mut(), pDatatype: raw.as_ptr() as *mut _ };
            let result = (|| {
                if StartDocPrinterW(h, 1, &info as *const _ as *const _) == 0 {
                    return Err("الطابعة رفضت الطباعة".to_string());
                }
                StartPagePrinter(h);
                let mut written = 0u32;
                let ok = WritePrinter(h, data.as_ptr() as *const _, data.len() as u32, &mut written);
                EndPagePrinter(h);
                EndDocPrinter(h);
                if ok == 0 || written as usize != data.len() {
                    return Err("ما وصلش الإيصال كامل للطابعة".to_string());
                }
                Ok(())
            })();
            ClosePrinter(h);
            result
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn list() -> Result<Vec<String>, String> {
        Ok(vec![])
    }
    pub fn write_raw(_printer: &str, _data: &[u8]) -> Result<(), String> {
        Err("الطباعة على طابعة مثبتة متاحة على ويندوز فقط؛ استعمل طابعة شبكة".into())
    }
}

pub use imp::{list, write_raw};
