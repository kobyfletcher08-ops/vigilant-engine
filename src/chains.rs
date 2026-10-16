use crate::Result;
use serde::{Deserialize, Serialize};

pub const WSOL: &str = "So11111111111111111111111111111111111111112";
pub const WBNB: &str = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
pub const WARB: &str = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chain {
    pub id: String,
    pub name: String,
}

pub fn catalogue() -> &'static [Chain] {
    static CHAINS: std::sync::OnceLock<Vec<Chain>> = std::sync::OnceLock::new();
    CHAINS
        .get_or_init(|| {
            serde_json::from_str(include_str!("chains.json")).expect("bundled chain catalogue")
        })
        .as_slice()
}
pub fn validate_chain(id: &str) -> Result<&str> {
    if id.is_empty()
        || id.len() > 48
        || !id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        || !id.as_bytes()[0].is_ascii_alphanumeric()
        || ["all", "constructor", "prototype", "__proto__"].contains(&id)
    {
        return Err("Invalid DEX Screener chain identifier.".into());
    }
    Ok(id)
}
pub fn is_evm(id: &str) -> bool {
    static EVM: std::sync::OnceLock<std::collections::HashSet<&'static str>> =
        std::sync::OnceLock::new();
    EVM.get_or_init(|| {
        catalogue()
            .iter()
            .filter(|c| {
                ![
                    "solana",
                    "near",
                    "ton",
                    "sui",
                    "xrpl",
                    "starknet",
                    "hyperliquid",
                    "tron",
                    "hedera",
                    "icp",
                    "multiversx",
                    "injective",
                    "cardano",
                    "aptos",
                    "algorand",
                    "stacks",
                    "movement",
                    "polkadot",
                ]
                .contains(&c.id.as_str())
            })
            .map(|c| c.id.as_str())
            .collect()
    })
    .contains(id)
}
pub fn valid_token(chain: &str, address: &str) -> bool {
    if chain == "solana" {
        return (32..=44).contains(&address.len())
            && bs58::decode(address)
                .into_vec()
                .map(|v| v.len() == 32)
                .unwrap_or(false);
    }
    if is_evm(chain) {
        return address.len() == 42
            && address.starts_with("0x")
            && address[2..].bytes().all(|c| c.is_ascii_hexdigit());
    }
    !address.is_empty()
        && address.len() <= 200
        && !address.contains("..")
        && address
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_:-./".contains(&c))
}
pub fn valid_pair(chain: &str, address: &str) -> bool {
    if is_evm(chain) {
        return [42, 66].contains(&address.len())
            && address.starts_with("0x")
            && address[2..].bytes().all(|c| c.is_ascii_hexdigit());
    }
    valid_token(chain, address)
}
pub fn address_key(chain: &str, address: &str) -> String {
    if is_evm(chain) {
        address.to_ascii_lowercase()
    } else {
        address.to_owned()
    }
}
pub fn seeds(chain: &str) -> Vec<String> {
    let values: &[&str] = match chain {
        "bsc" => &[
            WBNB,
            "0x55d398326f99059fF775485246999027B3197955",
            "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
            "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82",
        ],
        "arbitrum" => &[
            WARB,
            "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
            "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
        ],
        "solana" => &[
            WSOL,
            "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
        ],
        "ethereum" => &[
            "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        ],
        "base" => &[
            "0x4200000000000000000000000000000000000006",
            "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        ],
        "optimism" => &[
            "0x4200000000000000000000000000000000000006",
            "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
        ],
        _ => &[],
    };
    values.iter().map(|s| s.to_string()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_catalogue_and_future_chains_without_three_chain_gate() {
        assert!(catalogue().len() >= 64);
        for c in catalogue() {
            assert!(validate_chain(&c.id).is_ok());
        }
        assert!(validate_chain("future-chain-1").is_ok());
        for c in [
            "../solana",
            "all",
            "ETHEREUM",
            "https://evil",
            "constructor",
        ] {
            assert!(validate_chain(c).is_err());
        }
    }
    #[test]
    fn preserves_case_and_native_address_formats() {
        assert!(valid_token("solana", WSOL));
        assert!(!valid_token("solana", WBNB));
        assert_eq!(address_key("ethereum", WBNB), WBNB.to_ascii_lowercase());
        assert_ne!(address_key("ton", "EQAB"), address_key("ton", "EQab"));
        assert!(valid_token("sui", "0x123::coin::TOKEN"));
        assert!(valid_token("hedera", "0.0.123456"));
        assert!(valid_pair("ethereum", &format!("0x{}", "a".repeat(64))));
    }
}
