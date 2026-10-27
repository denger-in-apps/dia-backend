export declare class EncryptionService {
    private readonly keys;
    private readonly activeKeyId;
    constructor();
    encrypt(plaintext: Buffer | string, aad: string): Buffer;
    decrypt(envelope: Buffer, aad: string): Buffer;
    private assertAad;
}
