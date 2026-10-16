use crate::{rpc::keccak, storage::write_private, Result};
use aes_gcm::{
    aead::{Aead, Payload},
    Aes256Gcm, KeyInit, Nonce,
};
use argon2::Argon2;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use bip39::{Language, Mnemonic};
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha512;
use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;
use unicode_normalization::UnicodeNormalization;
use zeroize::Zeroizing;

pub const EVM_PATH: &str = "m/44'/60'/0'/0/0";
pub const SOL_PATH: &str = "m/44'/501'/0'/0'";
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Vault {
    pub version: u8,
    pub kind: String,
    pub address: String,
    pub path: String,
    pub algorithm: String,
    pub salt: String,
    pub nonce: String,
    pub ciphertext: String,
}
#[derive(Serialize)]
pub struct Account {
    pub kind: String,
    pub address: String,
    pub path: String,
    pub unlocked: bool,
}
struct Unlocked {
    key: Zeroizing<[u8; 32]>,
    at: Instant,
}
pub struct Wallets {
    file: PathBuf,
    vaults: Mutex<HashMap<String, Vault>>,
    unlocked: Mutex<HashMap<String, Unlocked>>,
}
fn kind(k: &str) -> Result<()> {
    if !["evm", "solana"].contains(&k) {
        return Err("Choose an EVM or Solana account.".into());
    }
    Ok(())
}
fn valid_path(path: &str, solana: bool) -> Result<Vec<u32>> {
    if path.len() > 160 || !path.starts_with("m/") {
        return Err("Invalid derivation path.".into());
    }
    let mut out = Vec::new();
    for item in path[2..].split('/') {
        let hardened = item.ends_with('\'');
        if solana && !hardened {
            return Err("Solana derivation paths must be fully hardened.".into());
        }
        let value = item.trim_end_matches('\'');
        if value.is_empty()
            || value.len() > 1 && value.starts_with('0')
            || !value.bytes().all(|b| b.is_ascii_digit())
        {
            return Err("Invalid derivation path index.".into());
        }
        let n: u32 = value
            .parse()
            .map_err(|_| "Invalid derivation path index.")?;
        if n >= 0x80000000 {
            return Err("Each derivation index must be below 2^31.".into());
        }
        out.push(if hardened { n | 0x80000000 } else { n });
    }
    if out.is_empty() || out.len() > 10 {
        return Err("Use 1–10 derivation indices.".into());
    }
    Ok(out)
}
pub fn derive(
    kind_value: &str,
    phrase: &str,
    passphrase: &str,
    path: &str,
) -> Result<Zeroizing<[u8; 32]>> {
    kind(kind_value)?;
    let indices = valid_path(path, kind_value == "solana")?;
    if phrase.len() > 600 || passphrase.len() > 1024 {
        return Err("Wallet import exceeds the input limit.".into());
    }
    let mut normalized = Zeroizing::new(phrase.nfkd().collect::<String>());
    normalized.make_ascii_lowercase();
    let normalized = Zeroizing::new(normalized.split_whitespace().collect::<Vec<_>>().join(" "));
    let mnemonic = Mnemonic::parse_in_normalized(Language::English, &normalized)
        .map_err(|_| "Enter a valid English BIP-39 recovery phrase (12–24 words).")?;
    let passphrase = Zeroizing::new(passphrase.nfkd().collect::<String>());
    let seed = Zeroizing::new(mnemonic.to_seed_normalized(&passphrase));
    if kind_value == "evm" {
        let path: bip32::DerivationPath =
            path.parse().map_err(|_| "Invalid EVM derivation path.")?;
        let child = bip32::XPrv::derive_from_path(seed.as_ref(), &path)
            .map_err(|_| "EVM key derivation failed.")?;
        let mut key = [0; 32];
        key.copy_from_slice(&child.private_key().to_bytes());
        Ok(Zeroizing::new(key))
    } else {
        let mut mac = <Hmac<Sha512> as Mac>::new_from_slice(b"ed25519 seed").unwrap();
        mac.update(seed.as_ref());
        let mut material = Zeroizing::new(mac.finalize().into_bytes().to_vec());
        for index in indices {
            let mut data = Zeroizing::new(vec![0u8]);
            data.extend_from_slice(&material[..32]);
            data.extend_from_slice(&index.to_be_bytes());
            let mut mac = <Hmac<Sha512> as Mac>::new_from_slice(&material[32..]).unwrap();
            mac.update(&data);
            material = Zeroizing::new(mac.finalize().into_bytes().to_vec());
        }
        let mut key = [0; 32];
        key.copy_from_slice(&material[..32]);
        Ok(Zeroizing::new(key))
    }
}
pub fn account_address(kind: &str, key: &[u8; 32]) -> Result<String> {
    if kind == "evm" {
        let signing = k256::ecdsa::SigningKey::from_slice(key).map_err(|_| "Invalid EVM key.")?;
        let public = signing.verifying_key().to_encoded_point(false);
        Ok(format!(
            "0x{}",
            hex::encode(&keccak(&public.as_bytes()[1..])[12..])
        ))
    } else if kind == "solana" {
        Ok(bs58::encode(
            ed25519_dalek::SigningKey::from_bytes(key)
                .verifying_key()
                .as_bytes(),
        )
        .into_string())
    } else {
        Err("Unknown wallet type.".into())
    }
}
fn aad(v: &Vault) -> Vec<u8> {
    format!("2|{}|{}|{}", v.kind, v.address, v.path).into_bytes()
}
fn encrypt(kind: &str, key: &[u8; 32], password: &str, path: &str) -> Result<Vault> {
    if password.len() < 12 || password.len() > 1024 {
        return Err("Use an encryption password with 12–1024 characters.".into());
    }
    let mut salt = [0; 16];
    let mut nonce = [0; 12];
    rand::thread_rng().fill_bytes(&mut salt);
    rand::thread_rng().fill_bytes(&mut nonce);
    let mut derived = Zeroizing::new([0u8; 32]);
    Argon2::default()
        .hash_password_into(password.as_bytes(), &salt, derived.as_mut())
        .map_err(|_| "Wallet encryption failed.")?;
    let mut vault = Vault {
        version: 2,
        kind: kind.into(),
        address: account_address(kind, key)?,
        path: path.into(),
        algorithm: "argon2id-aes256gcm".into(),
        salt: B64.encode(salt),
        nonce: B64.encode(nonce),
        ciphertext: String::new(),
    };
    let cipher = Aes256Gcm::new_from_slice(derived.as_ref()).unwrap();
    let encrypted = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: key,
                aad: &aad(&vault),
            },
        )
        .map_err(|_| "Wallet encryption failed.")?;
    vault.ciphertext = B64.encode(encrypted);
    Ok(vault)
}
fn decrypt(v: &Vault, password: &str) -> Result<Zeroizing<[u8; 32]>> {
    kind(&v.kind)?;
    valid_path(&v.path, v.kind == "solana")?;
    if v.version != 2 || v.algorithm != "argon2id-aes256gcm" || password.len() > 1024 {
        return Err("Unsupported native wallet backup.".into());
    }
    let salt = B64.decode(&v.salt).map_err(|_| "Invalid wallet backup.")?;
    let nonce = B64.decode(&v.nonce).map_err(|_| "Invalid wallet backup.")?;
    let ciphertext = B64
        .decode(&v.ciphertext)
        .map_err(|_| "Invalid wallet backup.")?;
    if salt.len() != 16 || nonce.len() != 12 || ciphertext.len() != 48 {
        return Err("Invalid encrypted wallet size.".into());
    }
    let mut derived = Zeroizing::new([0; 32]);
    Argon2::default()
        .hash_password_into(password.as_bytes(), &salt, derived.as_mut())
        .map_err(|_| "Wallet unlock failed.")?;
    let cipher = Aes256Gcm::new_from_slice(derived.as_ref()).unwrap();
    let plain = Zeroizing::new(
        cipher
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: &aad(v),
                },
            )
            .map_err(|_| "Incorrect password or damaged encrypted wallet.")?,
    );
    let mut key = Zeroizing::new([0; 32]);
    key.copy_from_slice(&plain);
    if account_address(&v.kind, &key)? != v.address {
        return Err("Wallet address does not match its encrypted key.".into());
    }
    Ok(key)
}
impl Wallets {
    pub fn open(dir: &std::path::Path) -> Result<Self> {
        let file = dir.join("wallets.json");
        let vaults = match fs::read(&file) {
            Ok(b) if b.len() < 128000 => serde_json::from_slice(&b).map_err(|_| {
                "Encrypted wallet file is damaged. Restore a backup; do not delete the data folder."
            })?,
            Ok(_) => return Err("Encrypted wallet file exceeds the size limit.".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
            Err(_) => return Err("Cannot read encrypted wallet file.".into()),
        };
        Ok(Self {
            file,
            vaults: Mutex::new(vaults),
            unlocked: Mutex::new(HashMap::new()),
        })
    }
    fn install(&self, vault: Vault, key: Zeroizing<[u8; 32]>) -> Result<Vec<Account>> {
        let kind = vault.kind.clone();
        let mut saved = self.vaults.lock().unwrap();
        saved.insert(kind.clone(), vault);
        write_private(
            &self.file,
            &serde_json::to_vec_pretty(&*saved).map_err(|_| "Cannot encode encrypted wallet.")?,
        )?;
        drop(saved);
        self.unlocked.lock().unwrap().insert(
            kind,
            Unlocked {
                key,
                at: Instant::now(),
            },
        );
        Ok(self.accounts())
    }
    pub fn import(
        &self,
        kind: &str,
        phrase: &str,
        passphrase: &str,
        path: &str,
        password: &str,
    ) -> Result<Vec<Account>> {
        let key = derive(kind, phrase, passphrase, path)?;
        let vault = encrypt(kind, &key, password, path)?;
        self.install(vault, key)
    }
    pub fn unlock(&self, kind: &str, password: &str) -> Result<Vec<Account>> {
        let v = self
            .vaults
            .lock()
            .unwrap()
            .get(kind)
            .cloned()
            .ok_or("Import a wallet or encrypted backup first.")?;
        let key = decrypt(&v, password)?;
        self.unlocked.lock().unwrap().insert(
            kind.into(),
            Unlocked {
                key,
                at: Instant::now(),
            },
        );
        Ok(self.accounts())
    }
    pub fn accounts(&self) -> Vec<Account> {
        let mut unlocked = self.unlocked.lock().unwrap();
        unlocked.retain(|_, v| v.at.elapsed() < Duration::from_secs(300));
        self.vaults
            .lock()
            .unwrap()
            .values()
            .map(|v| Account {
                kind: v.kind.clone(),
                address: v.address.clone(),
                path: v.path.clone(),
                unlocked: unlocked.contains_key(&v.kind),
            })
            .collect()
    }
    pub fn lock(&self) {
        self.unlocked.lock().unwrap().clear();
    }
    pub fn key(&self, kind: &str) -> Result<Zeroizing<[u8; 32]>> {
        let mut keys = self.unlocked.lock().unwrap();
        keys.retain(|_, v| v.at.elapsed() < Duration::from_secs(300));
        let k = keys
            .get(kind)
            .ok_or("Unlock the wallet first. Accounts lock after five minutes.")?;
        Ok(Zeroizing::new(*k.key))
    }
    pub fn address(&self, kind: &str) -> Result<String> {
        let key = self.key(kind)?;
        account_address(kind, &key)
    }
    pub fn backup(&self, kind: &str) -> Result<Vault> {
        self.vaults
            .lock()
            .unwrap()
            .get(kind)
            .cloned()
            .ok_or("No encrypted wallet has been imported.".into())
    }
    pub fn import_backup(&self, input: &str, password: &str) -> Result<Vec<Account>> {
        if input.len() > 128000 {
            return Err("Encrypted backup exceeds the size limit.".into());
        }
        let value: Value =
            serde_json::from_str(input).map_err(|_| "Invalid encrypted wallet JSON.")?;
        if value.get("version").and_then(Value::as_u64) == Some(2) {
            let vault: Vault =
                serde_json::from_value(value).map_err(|_| "Invalid native wallet backup.")?;
            let key = decrypt(&vault, password)?;
            return self.install(vault, key);
        }
        let (kind, key, path) = if value.get("chain").and_then(Value::as_str) == Some("solana") {
            let iterations = value
                .get("iterations")
                .and_then(Value::as_u64)
                .ok_or("Invalid Solana backup.")?;
            if !(310000..=1000000).contains(&iterations) {
                return Err("Solana backup KDF exceeds the supported bounds.".into());
            }
            let field = |name: &str| -> Result<Vec<u8>> {
                B64.decode(
                    value
                        .get(name)
                        .and_then(Value::as_str)
                        .ok_or("Missing encrypted backup field.")?,
                )
                .map_err(|_| "Invalid backup encoding.".into())
            };
            let salt = field("salt")?;
            let iv = field("iv")?;
            let ciphertext = field("ciphertext")?;
            if salt.len() != 16 || iv.len() != 12 || ciphertext.len() != 48 {
                return Err("Invalid Solana encrypted backup size.".into());
            }
            let mut derived = Zeroizing::new([0; 32]);
            pbkdf2::pbkdf2_hmac::<sha2::Sha256>(
                password.as_bytes(),
                &salt,
                iterations as u32,
                derived.as_mut(),
            );
            let plain = Zeroizing::new(
                Aes256Gcm::new_from_slice(derived.as_ref())
                    .unwrap()
                    .decrypt(Nonce::from_slice(&iv), ciphertext.as_ref())
                    .map_err(|_| "Incorrect password or damaged Solana backup.")?,
            );
            let mut key = Zeroizing::new([0; 32]);
            key.copy_from_slice(&plain);
            (
                "solana",
                key,
                value
                    .get("path")
                    .and_then(Value::as_str)
                    .unwrap_or(SOL_PATH)
                    .to_string(),
            )
        } else {
            use ctr::cipher::{KeyIvInit, StreamCipher};
            let c = value
                .get("crypto")
                .or_else(|| value.get("Crypto"))
                .ok_or("Expected an Ethereum V3 scrypt keystore or native encrypted backup.")?;
            let p = c.get("kdfparams").ok_or("Missing scrypt parameters.")?;
            let n = p["n"].as_u64().unwrap_or(0);
            let r = p["r"].as_u64().unwrap_or(0);
            let parallel = p["p"].as_u64().unwrap_or(0);
            if value["version"] != 3
                || c["kdf"] != "scrypt"
                || c["cipher"] != "aes-128-ctr"
                || !(16384..=262144).contains(&n)
                || !n.is_power_of_two()
                || r != 8
                || !(1..=4).contains(&parallel)
                || p["dklen"] != 32
            {
                return Err("Use a bounded Ethereum V3 scrypt keystore.".into());
            }
            let field = |v: &Value| {
                hex::decode(v.as_str().unwrap_or(""))
                    .map_err(|_| "Invalid Ethereum keystore encoding.".to_string())
            };
            let salt = field(&p["salt"])?;
            let iv = field(&c["cipherparams"]["iv"])?;
            let ciphertext = field(&c["ciphertext"])?;
            let mac = field(&c["mac"])?;
            if !(16..=64).contains(&salt.len())
                || iv.len() != 16
                || ciphertext.len() != 32
                || mac.len() != 32
            {
                return Err("Invalid Ethereum keystore field size.".into());
            }
            let mut derived = Zeroizing::new([0u8; 32]);
            let params = scrypt::Params::new(n.ilog2() as u8, r as u32, parallel as u32, 32)
                .map_err(|_| "Invalid scrypt parameters.")?;
            scrypt::scrypt(password.as_bytes(), &salt, &params, derived.as_mut())
                .map_err(|_| "Keystore unlock failed.")?;
            let mut material = Zeroizing::new(derived[16..].to_vec());
            material.extend_from_slice(&ciphertext);
            if !bool::from(keccak(&material).ct_eq(mac.as_slice())) {
                return Err("Incorrect password or damaged Ethereum keystore.".into());
            }
            let mut key = Zeroizing::new([0u8; 32]);
            key.copy_from_slice(&ciphertext);
            let mut cipher =
                <ctr::Ctr128BE<aes::Aes128> as KeyIvInit>::new_from_slices(&derived[..16], &iv)
                    .map_err(|_| "Invalid Ethereum cipher parameters.")?;
            cipher.apply_keystream(key.as_mut());
            ("evm", key, EVM_PATH.to_string())
        };
        valid_path(&path, kind == "solana")?;
        let actual = account_address(kind, &key)?;
        let expected = value
            .get("address")
            .and_then(Value::as_str)
            .ok_or("Backup address is missing.")?;
        let expected = if kind == "evm" {
            format!(
                "0x{}",
                expected.trim_start_matches("0x").to_ascii_lowercase()
            )
        } else {
            expected.into()
        };
        if actual != expected {
            return Err("Encrypted backup address does not match its key.".into());
        }
        self.install(encrypt(kind, &key, password, &path)?, key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const PHRASE:&str="abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    #[test]
    fn native_derivation_matches_existing_evm_and_solana_accounts() {
        let a = derive("evm", PHRASE, "", EVM_PATH).unwrap();
        assert_eq!(
            account_address("evm", &a).unwrap(),
            "0x9858effd232b4033e47d90003d41ec34ecaeda94"
        );
        let b = derive("solana", PHRASE, "", SOL_PATH).unwrap();
        assert_eq!(
            account_address("solana", &b).unwrap(),
            "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk"
        );
        assert!(derive("solana", PHRASE, "", "m/44/501/0/0").is_err());
        assert!(derive("evm", PHRASE, "", "m/44'/60'/2147483648'/0/0").is_err());
    }
    #[test]
    fn encrypted_vault_authenticates_metadata_and_never_contains_seed() {
        let key = derive("evm", PHRASE, "", EVM_PATH).unwrap();
        let vault = encrypt("evm", &key, "public-test-password", EVM_PATH).unwrap();
        let text = serde_json::to_string(&vault).unwrap();
        assert!(!text.contains(PHRASE));
        assert!(!text.contains("public-test-password"));
        assert!(!text.contains(&hex::encode(key.as_ref())));
        assert_eq!(*decrypt(&vault, "public-test-password").unwrap(), *key);
        assert!(decrypt(&vault, "incorrect").is_err());
        let mut changed = vault;
        changed.path = "m/44'/60'/1'/0/0".into();
        assert!(decrypt(&changed, "public-test-password").is_err());
    }
}
