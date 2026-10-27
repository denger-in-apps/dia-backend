const { existsSync, writeFileSync } = require('fs');
const { join } = require('path');
const { generateKeyPairSync } = require('crypto');

const privatePath = join(__dirname, 'jwt_private.pem');
const publicPath = join(__dirname, 'jwt_public.pem');
if (existsSync(privatePath) || existsSync(publicPath)) {
  throw new Error('JWT key files already exist; refusing to overwrite them');
}

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 3072,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

writeFileSync(privatePath, privateKey, { flag: 'wx', mode: 0o600 });
writeFileSync(publicPath, publicKey, { flag: 'wx', mode: 0o644 });
process.stdout.write('Development JWT keypair generated under infra/auth/. Keep the private key out of Git.\n');
