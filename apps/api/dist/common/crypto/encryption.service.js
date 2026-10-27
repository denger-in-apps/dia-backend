"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EncryptionService = void 0;
const crypto_1 = require("crypto");
const common_1 = require("@nestjs/common");
const ENVELOPE_VERSION = 1;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;
const MAX_KEY_ID_BYTES = 64;
let EncryptionService = class EncryptionService {
    constructor() {
        this.keys = new Map();
        this.activeKeyId = process.env.ENCRYPTION_ACTIVE_KEY_ID ?? '';
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(this.activeKeyId)) {
            throw new Error('ENCRYPTION_ACTIVE_KEY_ID harus diisi dengan ID kunci yang valid');
        }
        for (const [name, value] of Object.entries(process.env)) {
            const match = name.match(/^ENCRYPTION_KEY_([A-Za-z0-9_-]{1,64})$/);
            if (!match || !value)
                continue;
            const key = Buffer.from(value, 'base64');
            if (key.length !== KEY_BYTES || key.toString('base64') !== value) {
                throw new Error(`${name} harus berupa base64 kanonis dari tepat 32 byte`);
            }
            this.keys.set(match[1], key);
        }
        if (!this.keys.has(this.activeKeyId)) {
            throw new Error(`ENCRYPTION_KEY_${this.activeKeyId} tidak tersedia`);
        }
    }
    encrypt(plaintext, aad) {
        this.assertAad(aad);
        const keyId = Buffer.from(this.activeKeyId, 'utf8');
        if (keyId.length > MAX_KEY_ID_BYTES) {
            throw new Error('ID kunci terlalu panjang');
        }
        const iv = (0, crypto_1.randomBytes)(IV_BYTES);
        const cipher = (0, crypto_1.createCipheriv)('aes-256-gcm', this.keys.get(this.activeKeyId), iv);
        cipher.setAAD(Buffer.from(aad, 'utf8'));
        const input = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8');
        const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
        const header = Buffer.from([ENVELOPE_VERSION, keyId.length]);
        return Buffer.concat([header, keyId, iv, ciphertext, cipher.getAuthTag()]);
    }
    decrypt(envelope, aad) {
        this.assertAad(aad);
        if (!Buffer.isBuffer(envelope) || envelope.length < 2 + IV_BYTES + AUTH_TAG_BYTES) {
            throw new Error('Envelope enkripsi tidak valid');
        }
        const version = envelope[0];
        const keyIdLength = envelope[1];
        if (version !== ENVELOPE_VERSION ||
            keyIdLength === 0 ||
            keyIdLength > MAX_KEY_ID_BYTES ||
            envelope.length < 2 + keyIdLength + IV_BYTES + AUTH_TAG_BYTES) {
            throw new Error('Envelope enkripsi tidak valid');
        }
        const keyIdStart = 2;
        const ivStart = keyIdStart + keyIdLength;
        const ciphertextStart = ivStart + IV_BYTES;
        const tagStart = envelope.length - AUTH_TAG_BYTES;
        const keyId = envelope.subarray(keyIdStart, ivStart).toString('utf8');
        const key = this.keys.get(keyId);
        if (!key)
            throw new Error(`Kunci enkripsi dengan ID "${keyId}" tidak tersedia`);
        try {
            const decipher = (0, crypto_1.createDecipheriv)('aes-256-gcm', key, envelope.subarray(ivStart, ciphertextStart));
            decipher.setAAD(Buffer.from(aad, 'utf8'));
            decipher.setAuthTag(envelope.subarray(tagStart));
            return Buffer.concat([
                decipher.update(envelope.subarray(ciphertextStart, tagStart)),
                decipher.final(),
            ]);
        }
        catch {
            throw new Error('Autentikasi ciphertext gagal; AAD salah atau data telah berubah');
        }
    }
    assertAad(aad) {
        if (typeof aad !== 'string' || aad.trim().length === 0) {
            throw new Error('AAD wajib diisi, misalnya tabel:kolom:id_baris');
        }
    }
};
exports.EncryptionService = EncryptionService;
exports.EncryptionService = EncryptionService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [])
], EncryptionService);
//# sourceMappingURL=encryption.service.js.map