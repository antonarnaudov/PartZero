//! A minimal, deterministic ZIP container (PKWARE APPNOTE 6.3, no ZIP64, no
//! encryption) for OPC packages such as 3MF.
//!
//! # Writer
//! - Entries are written **sorted by name** (byte order), each with a fixed timestamp
//!   (1980-01-01 00:00:00, the DOS epoch), no extra fields, no comments and no data
//!   descriptors, so the same entries always produce the same bytes.
//! - Data is compressed with raw DEFLATE ([`miniz_oxide`], level 6) and stored instead
//!   when that is not smaller.
//!
//! # Reader
//! Parses the end-of-central-directory record and the central directory, checks every
//! local header against it, inflates (method 8) or copies (method 0) the data with the
//! declared size as a hard limit, and verifies the CRC-32. Encrypted entries, ZIP64 and
//! other methods are rejected with [`IoError::Zip`].
//!
//! Only the DEFLATE codec is borrowed; the container logic and CRC-32 are ours.

use std::collections::BTreeMap;

use crate::IoError;

const LOCAL_SIG: u32 = 0x0403_4b50;
const CENTRAL_SIG: u32 = 0x0201_4b50;
const EOCD_SIG: u32 = 0x0605_4b50;
/// DOS date for 1980-01-01 (`(year − 1980) << 9 | month << 5 | day`).
const DOS_DATE_EPOCH: u16 = (1 << 5) | 1;
const DOS_TIME_MIDNIGHT: u16 = 0;
const VERSION_20: u16 = 20;
const METHOD_STORE: u16 = 0;
const METHOD_DEFLATE: u16 = 8;
const DEFLATE_LEVEL: u8 = 6;

/// CRC-32 (IEEE 802.3, reflected polynomial `0xEDB88320`) lookup table.
const CRC_TABLE: [u32; 256] = {
    let mut t = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut c = i as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 {
                0xEDB8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
            k += 1;
        }
        t[i] = c;
        i += 1;
    }
    t
};

/// CRC-32 of `data` (as used by ZIP, PNG, gzip).
pub fn crc32(data: &[u8]) -> u32 {
    let mut c = 0xFFFF_FFFFu32;
    for &b in data {
        c = CRC_TABLE[((c ^ u32::from(b)) & 0xFF) as usize] ^ (c >> 8);
    }
    c ^ 0xFFFF_FFFF
}

fn zip_err(detail: impl Into<String>) -> IoError {
    IoError::Zip {
        detail: detail.into(),
    }
}

fn put16(out: &mut Vec<u8>, v: u16) {
    out.extend_from_slice(&v.to_le_bytes());
}
fn put32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}

fn to_u32(n: usize, what: &str) -> Result<u32, IoError> {
    u32::try_from(n).map_err(|_| zip_err(format!("{what} exceeds 4 GiB (ZIP64 not supported)")))
}

/// Write a ZIP archive with the given `(name, data)` entries (sorted by name).
pub fn write_zip(entries: &[(&str, &[u8])]) -> Result<Vec<u8>, IoError> {
    let mut sorted: Vec<&(&str, &[u8])> = entries.iter().collect();
    sorted.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    for w in sorted.windows(2) {
        if w[0].0 == w[1].0 {
            return Err(zip_err(format!("duplicate entry {}", w[0].0)));
        }
    }
    if sorted.len() > usize::from(u16::MAX) {
        return Err(zip_err("too many entries"));
    }
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (name, data) in sorted {
        if name.is_empty() || !name.is_ascii() || name.len() > usize::from(u16::MAX) {
            return Err(zip_err(format!("invalid entry name {name:?}")));
        }
        let deflated = miniz_oxide::deflate::compress_to_vec(data, DEFLATE_LEVEL);
        let (method, payload): (u16, &[u8]) = if deflated.len() < data.len() {
            (METHOD_DEFLATE, &deflated)
        } else {
            (METHOD_STORE, data)
        };
        let crc = crc32(data);
        let offset = to_u32(out.len(), "archive")?;
        let csize = to_u32(payload.len(), "entry")?;
        let usize_ = to_u32(data.len(), "entry")?;
        let name_len = name.len() as u16;
        // Local file header.
        put32(&mut out, LOCAL_SIG);
        put16(&mut out, VERSION_20);
        put16(&mut out, 0);
        put16(&mut out, method);
        put16(&mut out, DOS_TIME_MIDNIGHT);
        put16(&mut out, DOS_DATE_EPOCH);
        put32(&mut out, crc);
        put32(&mut out, csize);
        put32(&mut out, usize_);
        put16(&mut out, name_len);
        put16(&mut out, 0);
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(payload);
        // Central directory header.
        put32(&mut central, CENTRAL_SIG);
        put16(&mut central, VERSION_20); // made by: MS-DOS, 2.0
        put16(&mut central, VERSION_20);
        put16(&mut central, 0);
        put16(&mut central, method);
        put16(&mut central, DOS_TIME_MIDNIGHT);
        put16(&mut central, DOS_DATE_EPOCH);
        put32(&mut central, crc);
        put32(&mut central, csize);
        put32(&mut central, usize_);
        put16(&mut central, name_len);
        put16(&mut central, 0); // extra
        put16(&mut central, 0); // comment
        put16(&mut central, 0); // disk
        put16(&mut central, 0); // internal attributes
        put32(&mut central, 0); // external attributes
        put32(&mut central, offset);
        central.extend_from_slice(name.as_bytes());
    }
    let cd_offset = to_u32(out.len(), "archive")?;
    let cd_size = to_u32(central.len(), "central directory")?;
    let count = u16::try_from(entries.len()).map_err(|_| zip_err("too many entries"))?;
    out.extend_from_slice(&central);
    put32(&mut out, EOCD_SIG);
    put16(&mut out, 0);
    put16(&mut out, 0);
    put16(&mut out, count);
    put16(&mut out, count);
    put32(&mut out, cd_size);
    put32(&mut out, cd_offset);
    put16(&mut out, 0);
    Ok(out)
}

struct Reader<'a> {
    b: &'a [u8],
}

impl Reader<'_> {
    fn u16(&self, at: usize) -> Result<u16, IoError> {
        self.b
            .get(at..at + 2)
            .map(|s| u16::from_le_bytes([s[0], s[1]]))
            .ok_or_else(|| zip_err("truncated archive"))
    }
    fn u32(&self, at: usize) -> Result<u32, IoError> {
        self.b
            .get(at..at + 4)
            .map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
            .ok_or_else(|| zip_err("truncated archive"))
    }
    fn slice(&self, at: usize, len: usize) -> Result<&[u8], IoError> {
        at.checked_add(len)
            .and_then(|end| self.b.get(at..end))
            .ok_or_else(|| zip_err("truncated archive"))
    }
}

/// Read every entry of a ZIP archive: name → uncompressed bytes (sorted by name).
pub fn read_zip(bytes: &[u8]) -> Result<BTreeMap<String, Vec<u8>>, IoError> {
    let r = Reader { b: bytes };
    if bytes.len() < 22 {
        return Err(zip_err("not a zip archive (too short)"));
    }
    // End of central directory: scan back over a possible comment (≤ 65535 bytes).
    let lowest = bytes.len().saturating_sub(22 + 65_535);
    let mut eocd = None;
    let mut at = bytes.len() - 22;
    loop {
        if r.u32(at)? == EOCD_SIG {
            eocd = Some(at);
            break;
        }
        if at == lowest {
            break;
        }
        at -= 1;
    }
    let eocd = eocd.ok_or_else(|| zip_err("end of central directory not found"))?;
    let count = usize::from(r.u16(eocd + 10)?);
    let cd_size = r.u32(eocd + 12)? as usize;
    let cd_offset = r.u32(eocd + 16)? as usize;
    if cd_offset == 0xFFFF_FFFF || count == 0xFFFF {
        return Err(zip_err("ZIP64 archives are not supported"));
    }
    r.slice(cd_offset, cd_size)?;
    let mut out = BTreeMap::new();
    let mut p = cd_offset;
    for _ in 0..count {
        if r.u32(p)? != CENTRAL_SIG {
            return Err(zip_err("bad central directory header"));
        }
        let flags = r.u16(p + 8)?;
        let method = r.u16(p + 10)?;
        let crc = r.u32(p + 16)?;
        let csize = r.u32(p + 20)? as usize;
        let usize_ = r.u32(p + 24)? as usize;
        let name_len = usize::from(r.u16(p + 28)?);
        let extra_len = usize::from(r.u16(p + 30)?);
        let comment_len = usize::from(r.u16(p + 32)?);
        let local = r.u32(p + 42)? as usize;
        let name_bytes = r.slice(p + 46, name_len)?;
        let name = String::from_utf8(name_bytes.to_vec())
            .map_err(|_| zip_err("entry name is not UTF-8"))?;
        if flags & 1 != 0 {
            return Err(zip_err(format!("entry {name} is encrypted")));
        }
        if csize == 0xFFFF_FFFF || usize_ == 0xFFFF_FFFF {
            return Err(zip_err("ZIP64 entries are not supported"));
        }
        if r.u32(local)? != LOCAL_SIG {
            return Err(zip_err(format!("bad local header for {name}")));
        }
        let lname = usize::from(r.u16(local + 26)?);
        let lextra = usize::from(r.u16(local + 28)?);
        let data = r.slice(local + 30 + lname + lextra, csize)?;
        let content = match method {
            METHOD_STORE => {
                if csize != usize_ {
                    return Err(zip_err(format!(
                        "stored entry {name} has inconsistent sizes"
                    )));
                }
                data.to_vec()
            }
            METHOD_DEFLATE => miniz_oxide::inflate::decompress_to_vec_with_limit(data, usize_)
                .map_err(|e| zip_err(format!("entry {name}: inflate failed ({:?})", e.status)))?,
            m => return Err(zip_err(format!("entry {name}: unsupported method {m}"))),
        };
        if content.len() != usize_ {
            return Err(zip_err(format!("entry {name}: size mismatch")));
        }
        if crc32(&content) != crc {
            return Err(zip_err(format!("entry {name}: CRC mismatch")));
        }
        if out.insert(name.clone(), content).is_some() {
            return Err(zip_err(format!("duplicate entry {name}")));
        }
        p += 46 + name_len + extra_len + comment_len;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc32_matches_the_standard_check_value() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(crc32(b""), 0);
    }

    #[test]
    fn zip_round_trips_sorted_and_deterministic() {
        let big = vec![b'a'; 10_000];
        let entries: [(&str, &[u8]); 3] = [("z.txt", b"zz"), ("a/b.bin", &big), ("m", b"")];
        let z1 = write_zip(&entries).expect("zip");
        let z2 = write_zip(&entries).expect("zip");
        assert_eq!(z1, z2);
        let back = read_zip(&z1).expect("read");
        let names: Vec<&str> = back.keys().map(String::as_str).collect();
        assert_eq!(names, ["a/b.bin", "m", "z.txt"]);
        assert_eq!(back["a/b.bin"], big);
        assert_eq!(back["z.txt"], b"zz");
        // Sorted in the file too: the first local header is a/b.bin.
        assert_eq!(&z1[30..37], b"a/b.bin");
        // Deflate kicked in for the compressible entry.
        assert!(z1.len() < 1_000);
    }

    #[test]
    fn corrupted_archives_are_rejected() {
        let z = write_zip(&[("x", b"hello hello hello hello")]).expect("zip");
        // Payload corruption: CRC mismatch or inflate failure.
        let mut bad = z.clone();
        bad[33] ^= 0x55;
        assert!(read_zip(&bad).is_err());
        // Broken local header signature.
        let mut bad = z.clone();
        bad[0] ^= 0xFF;
        assert!(read_zip(&bad).is_err());
        // Truncation.
        assert!(read_zip(&z[..z.len() - 1]).is_err());
        assert!(read_zip(b"not a zip at all, definitely not").is_err());
        assert!(write_zip(&[("a", b"1"), ("a", b"2")]).is_err());
    }
}
