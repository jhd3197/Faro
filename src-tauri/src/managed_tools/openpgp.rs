//! Just enough OpenPGP to check a detached v4 RSA signature (RFC 4880 §5.2)
//! against one pinned public key. Publishers such as 1Password ship a `.sig`
//! next to each binary instead of a checksum list; this is how Faro checks it
//! without a GnuPG install.

use anyhow::{anyhow, bail, ensure, Result};
use rsa::{traits::PublicKeyParts, BigUint, Pkcs1v15Sign, RsaPublicKey};
use sha2::{Digest, Sha256, Sha384, Sha512};
use std::io::Read;
use std::path::Path;

/// A pinned RSA signing key.
#[derive(Clone)]
pub struct PgpKey {
    /// The v4 fingerprint, which a signature's issuer subpacket names.
    pub fingerprint: [u8; 20],
    pub n: Vec<u8>,
    pub e: Vec<u8>,
}

impl PgpKey {
    pub fn from_hex(fingerprint: &str, n: &str, e: &str) -> Self {
        let bytes = |h: &str| -> Vec<u8> {
            let h: String = h.chars().filter(|c| !c.is_whitespace()).collect();
            (0..h.len()).step_by(2).map(|i| u8::from_str_radix(&h[i..i + 2], 16).expect("pinned key hex")).collect()
        };
        let fpr = bytes(fingerprint);
        Self { fingerprint: fpr.try_into().expect("a 20-byte fingerprint"), n: bytes(n), e: bytes(e) }
    }
}

/// A parsed v4 signature packet.
struct Signature {
    hash_algo: u8,
    /// Version through the end of the hashed subpackets: what the signer
    /// hashed after the data.
    hashed_part: Vec<u8>,
    issuer_fpr: Option<[u8; 20]>,
    issuer_id: Option<[u8; 8]>,
    left16: [u8; 2],
    value: Vec<u8>,
}

/// Subpacket types this check understands; a critical one outside this set
/// makes the signature invalid (RFC 4880 §5.2.3.1).
const KNOWN_SUBPACKETS: [u8; 3] = [2, 16, 33];

fn take<'a>(buf: &'a [u8], at: &mut usize, n: usize) -> Result<&'a [u8]> {
    let end = at.checked_add(n).filter(|e| *e <= buf.len()).ok_or_else(|| anyhow!("truncated signature"))?;
    let out = &buf[*at..end];
    *at = end;
    Ok(out)
}

/// The body of the first packet, which must be a signature (tag 2).
fn signature_body(raw: &[u8]) -> Result<&[u8]> {
    let mut at = 0;
    let head = take(raw, &mut at, 1)?[0];
    ensure!(head & 0x80 != 0, "not an OpenPGP packet");
    let (tag, len) = if head & 0x40 != 0 {
        let first = take(raw, &mut at, 1)?[0] as usize;
        let len = match first {
            0..=191 => first,
            192..=223 => ((first - 192) << 8) + take(raw, &mut at, 1)?[0] as usize + 192,
            255 => u32::from_be_bytes(take(raw, &mut at, 4)?.try_into()?) as usize,
            _ => bail!("partial-length signature packets aren't supported"),
        };
        (head & 0x3f, len)
    } else {
        let len = match head & 0x03 {
            0 => take(raw, &mut at, 1)?[0] as usize,
            1 => u16::from_be_bytes(take(raw, &mut at, 2)?.try_into()?) as usize,
            2 => u32::from_be_bytes(take(raw, &mut at, 4)?.try_into()?) as usize,
            _ => bail!("indeterminate-length signature packets aren't supported"),
        };
        ((head >> 2) & 0x0f, len)
    };
    ensure!(tag == 2, "not a signature packet");
    take(raw, &mut at, len)
}

fn subpackets(area: &[u8], hashed: bool, sig: &mut Signature) -> Result<()> {
    let mut at = 0;
    while at < area.len() {
        let first = take(area, &mut at, 1)?[0] as usize;
        let len = match first {
            0..=191 => first,
            192..=254 => ((first - 192) << 8) + take(area, &mut at, 1)?[0] as usize + 192,
            _ => u32::from_be_bytes(take(area, &mut at, 4)?.try_into()?) as usize,
        };
        ensure!(len >= 1, "empty signature subpacket");
        let body = take(area, &mut at, len)?;
        let (kind, critical, data) = (body[0] & 0x7f, body[0] & 0x80 != 0, &body[1..]);
        match kind {
            16 if data.len() == 8 => sig.issuer_id = Some(data.try_into()?),
            33 if data.len() == 21 && data[0] == 4 => sig.issuer_fpr = Some(data[1..].try_into()?),
            _ => {}
        }
        if hashed && critical && !KNOWN_SUBPACKETS.contains(&kind) {
            bail!("the signature has a critical part this check doesn't understand");
        }
    }
    Ok(())
}

fn parse(raw: &[u8]) -> Result<Signature> {
    let body = signature_body(raw)?;
    let mut at = 0;
    let head = take(body, &mut at, 6)?;
    ensure!(head[0] == 4, "only version 4 signatures are supported");
    ensure!(head[1] == 0x00, "not a signature over a file");
    ensure!(matches!(head[2], 1 | 3), "not an RSA signature");
    let hashed_len = u16::from_be_bytes([head[4], head[5]]) as usize;
    let hashed = take(body, &mut at, hashed_len)?;
    let mut sig = Signature {
        hash_algo: head[3],
        hashed_part: body[..6 + hashed_len].to_vec(),
        issuer_fpr: None,
        issuer_id: None,
        left16: [0; 2],
        value: Vec::new(),
    };
    subpackets(hashed, true, &mut sig)?;
    let unhashed_len = u16::from_be_bytes(take(body, &mut at, 2)?.try_into()?) as usize;
    let unhashed = take(body, &mut at, unhashed_len)?;
    subpackets(unhashed, false, &mut sig)?;
    sig.left16 = take(body, &mut at, 2)?.try_into()?;
    let bits = u16::from_be_bytes(take(body, &mut at, 2)?.try_into()?) as usize;
    sig.value = take(body, &mut at, bits.div_ceil(8))?.to_vec();
    Ok(sig)
}

/// Feeds the signed data, in chunks, to the sink it's given.
type Feed<'a> = &'a mut dyn FnMut(&mut dyn FnMut(&[u8])) -> Result<()>;

/// The signature's digest over `data` (fed in by `feed`) plus its trailer.
fn digest<D: Digest>(sig: &Signature, feed: Feed) -> Result<Vec<u8>> {
    let mut h = D::new();
    feed(&mut |chunk| h.update(chunk))?;
    h.update(&sig.hashed_part);
    h.update([0x04, 0xff]);
    h.update((sig.hashed_part.len() as u32).to_be_bytes());
    Ok(h.finalize().to_vec())
}

fn verify_with(key: &PgpKey, raw_sig: &[u8], feed: Feed) -> Result<()> {
    let sig = parse(raw_sig)?;
    let by_key = sig.issuer_fpr.map(|f| f == key.fingerprint).or(sig.issuer_id.map(|id| id == key.fingerprint[12..]));
    ensure!(by_key == Some(true), "it isn't signed by the publisher's key");
    let (digest, scheme) = match sig.hash_algo {
        8 => (digest::<Sha256>(&sig, feed)?, Pkcs1v15Sign::new::<Sha256>()),
        9 => (digest::<Sha384>(&sig, feed)?, Pkcs1v15Sign::new::<Sha384>()),
        10 => (digest::<Sha512>(&sig, feed)?, Pkcs1v15Sign::new::<Sha512>()),
        other => bail!("unsupported signature hash ({other})"),
    };
    ensure!(digest[..2] == sig.left16, "the signature doesn't match the file");
    let public = RsaPublicKey::new(BigUint::from_bytes_be(&key.n), BigUint::from_bytes_be(&key.e))
        .map_err(|_| anyhow!("bad pinned key"))?;
    // The MPI drops leading zero bytes; RSA wants the modulus' width.
    let width = public.size();
    ensure!(sig.value.len() <= width, "the signature doesn't match the file");
    let mut value = vec![0u8; width - sig.value.len()];
    value.extend_from_slice(&sig.value);
    public.verify(scheme, &digest, &value).map_err(|_| anyhow!("the signature doesn't match the file"))
}

/// Check `raw_sig` (a binary detached signature) over `data`.
pub fn verify(key: &PgpKey, raw_sig: &[u8], data: &[u8]) -> Result<()> {
    verify_with(key, raw_sig, &mut |sink| {
        sink(data);
        Ok(())
    })
}

/// Check `raw_sig` over the file at `path`, read in chunks.
pub fn verify_file(key: &PgpKey, raw_sig: &[u8], path: &Path) -> Result<()> {
    verify_with(key, raw_sig, &mut |sink| {
        let mut file = std::fs::File::open(path)?;
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = file.read(&mut buf)?;
            if n == 0 {
                return Ok(());
            }
            sink(&buf[..n]);
        }
    })
}

#[cfg(test)]
pub(crate) mod test_signer {
    //! Signs files the way a publisher would, with a throwaway key.
    use super::*;
    use rsa::RsaPrivateKey;

    pub struct Signer {
        pub key: PgpKey,
        private: RsaPrivateKey,
    }

    impl Signer {
        pub fn new() -> Self {
            let private = RsaPrivateKey::new(&mut rand::thread_rng(), 1024).expect("test key");
            let public = private.to_public_key();
            let n = public.n().to_bytes_be();
            // Any 20 bytes unique to the key will do for a test.
            let fingerprint = Sha256::digest(&n)[..20].try_into().unwrap();
            let key = PgpKey { fingerprint, n, e: public.e().to_bytes_be() };
            Self { key, private }
        }

        /// A binary v4 SHA-512 signature over `data`, issuer named by
        /// fingerprint, in an old-format packet like 1Password's.
        pub fn sign(&self, data: &[u8]) -> Vec<u8> {
            let mut hashed = vec![22u8, 33, 4];
            hashed.extend_from_slice(&self.key.fingerprint);
            hashed.extend_from_slice(&[5, 2, 0x6a, 0, 0, 0]);
            let mut part = vec![4u8, 0x00, 1, 10];
            part.extend_from_slice(&(hashed.len() as u16).to_be_bytes());
            part.extend_from_slice(&hashed);
            let mut h = Sha512::new();
            h.update(data);
            h.update(&part);
            h.update([0x04, 0xff]);
            h.update((part.len() as u32).to_be_bytes());
            let d = h.finalize();
            let value = self.private.sign(Pkcs1v15Sign::new::<Sha512>(), &d).unwrap();
            let mut body = part;
            body.extend_from_slice(&0u16.to_be_bytes());
            body.extend_from_slice(&d[..2]);
            body.extend_from_slice(&((value.len() * 8) as u16).to_be_bytes());
            body.extend_from_slice(&value);
            let mut packet = vec![0x89u8];
            packet.extend_from_slice(&(body.len() as u16).to_be_bytes());
            packet.extend_from_slice(&body);
            packet
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_signer::Signer;
    use super::*;

    #[test]
    fn a_good_signature_verifies_and_anything_else_fails() {
        let s = Signer::new();
        let sig = s.sign(b"the binary");
        verify(&s.key, &sig, b"the binary").unwrap();
        assert!(verify(&s.key, &sig, b"the binarY").is_err(), "changed file");
        let other = Signer::new();
        let mut wrong_key = other.key.clone();
        wrong_key.fingerprint = s.key.fingerprint;
        assert!(verify(&wrong_key, &sig, b"the binary").is_err(), "same issuer id, different key");
        assert!(verify(&other.key, &sig, b"the binary").unwrap_err().to_string().contains("isn't signed by"));
        let mut flipped = sig.clone();
        let last = flipped.len() - 1;
        flipped[last] ^= 1;
        assert!(verify(&s.key, &flipped, b"the binary").is_err(), "tampered signature");
        assert!(verify(&s.key, &sig[..sig.len() - 10], b"the binary").is_err(), "truncated");
        assert!(verify(&s.key, b"", b"the binary").is_err());
        assert!(verify(&s.key, b"\x00garbage", b"the binary").is_err());
    }

    #[test]
    fn files_are_read_in_chunks() {
        let s = Signer::new();
        let data: Vec<u8> = (0..3_000_000u32).map(|i| (i % 251) as u8).collect();
        let path = std::env::temp_dir().join(format!("faro-pgp-{}", std::process::id()));
        std::fs::write(&path, &data).unwrap();
        verify_file(&s.key, &s.sign(&data), &path).unwrap();
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn the_pinned_1password_key_is_well_formed() {
        let key = crate::password_managers::op_signing_key();
        assert_eq!(key.n.len(), 512);
        assert!(RsaPublicKey::new(BigUint::from_bytes_be(&key.n), BigUint::from_bytes_be(&key.e)).is_ok());
    }
}
