// 钱包：一对 ed25519 密钥 + 派生地址。
import * as ed from '@noble/ed25519';
import { bytesToHex, hexToBytes, getPublicKey, publicKeyToAddress } from './crypto.js';

export interface WalletData {
  privateKey: string; // hex
  publicKey: string; // hex
  address: string;
}

export class Wallet {
  readonly privateKey: Uint8Array;
  readonly publicKey: Uint8Array;
  readonly address: string;

  constructor(privateKey: Uint8Array) {
    this.privateKey = privateKey;
    this.publicKey = getPublicKey(privateKey);
    this.address = publicKeyToAddress(this.publicKey);
  }

  /** 随机生成一个新钱包 */
  static generate(): Wallet {
    return new Wallet(ed.utils.randomPrivateKey());
  }

  /** 从私钥 hex 还原钱包 */
  static fromPrivateKeyHex(hex: string): Wallet {
    return new Wallet(hexToBytes(hex));
  }

  toJSON(): WalletData {
    return {
      privateKey: bytesToHex(this.privateKey),
      publicKey: bytesToHex(this.publicKey),
      address: this.address,
    };
  }
}
