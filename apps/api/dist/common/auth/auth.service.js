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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthService = void 0;
const common_1 = require("@nestjs/common");
const jwt_1 = require("@nestjs/jwt");
const crypto_1 = require("crypto");
const argon2 = require("argon2");
const pg_1 = require("pg");
const encryption_service_1 = require("../crypto/encryption.service");
const database_module_1 = require("../../database/database.module");
const ACCESS_TOKEN_SECONDS = 15 * 60;
const DEFAULT_REFRESH_TOKEN_SECONDS = 7 * 24 * 60 * 60;
let AuthService = class AuthService {
    constructor(pool, jwt, encryption) {
        this.pool = pool;
        this.jwt = jwt;
        this.encryption = encryption;
    }
    async loginStaff(role, email, password, otp, ip, userAgent) {
        const isPsychologist = role === 'PSIKOLOG';
        const query = isPsychologist
            ? `SELECT id_psikolog::text AS id, nama, email::text AS email, password_hash,
                mfa_secret_enc, (status_akun = 'AKTIF') AS aktif
         FROM psikolog WHERE email = $1`
            : `SELECT id_dosen::text AS id, nama, email::text AS email, password_hash,
                mfa_secret_enc, aktif
         FROM dosen_admin WHERE email = $1`;
        const result = await this.pool.query(query, [email.trim().toLowerCase()]);
        const account = result.rows[0];
        if (!account?.password_hash)
            throw new common_1.UnauthorizedException('Email atau password salah');
        let passwordIsValid = false;
        try {
            passwordIsValid = await argon2.verify(account.password_hash, password);
        }
        catch {
            passwordIsValid = false;
        }
        if (!passwordIsValid)
            throw new common_1.UnauthorizedException('Email atau password salah');
        if (!account.aktif)
            throw new common_1.ForbiddenException('Akun staf belum aktif');
        if (account.mfa_secret_enc) {
            if (!otp || !this.verifyTotp(account.mfa_secret_enc, role, account.id, otp)) {
                throw new common_1.UnauthorizedException('Email atau password salah');
            }
        }
        else if (otp) {
            throw new common_1.UnauthorizedException('Email atau password salah');
        }
        return this.issueSession({ id: account.id, role }, ip, userAgent);
    }
    async loginStudent(identity, ip, userAgent) {
        let result;
        try {
            result = await this.pool.query(`INSERT INTO mahasiswa (sso_subject, nim, email, nama)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (nim) DO UPDATE
           SET sso_subject = EXCLUDED.sso_subject,
               email = EXCLUDED.email,
               nama = EXCLUDED.nama,
               updated_at = now()
         WHERE mahasiswa.deleted_at IS NULL
           AND (mahasiswa.sso_subject IS NULL OR mahasiswa.sso_subject = EXCLUDED.sso_subject)
         RETURNING id_mahasiswa::text AS id, status_aktif, deleted_at`, [identity.subject, identity.nim, identity.email, identity.name]);
        }
        catch {
            throw new common_1.UnauthorizedException('Akun SSO mahasiswa tidak dapat diverifikasi');
        }
        const student = result.rows[0];
        if (!student)
            throw new common_1.UnauthorizedException('Akun SSO mahasiswa tidak dapat diverifikasi');
        if (student.deleted_at || !student.status_aktif) {
            throw new common_1.ForbiddenException('AKUN_TIDAK_AKTIF');
        }
        return this.issueSession({ id: student.id, role: 'MAHASISWA' }, ip, userAgent);
    }
    async refresh(rawToken, ip, userAgent) {
        const tokenHash = this.hashToken(rawToken);
        const client = await this.pool.connect();
        let transactionOpen = false;
        try {
            await client.query('BEGIN');
            transactionOpen = true;
            const result = await client.query(`SELECT id::text, role, id_pengguna::text, token_family_id::text,
                expires_at, revoked_at, replaced_by::text
         FROM refresh_token WHERE token_hash = $1 FOR UPDATE`, [tokenHash]);
            const previous = result.rows[0];
            if (!previous)
                throw new common_1.UnauthorizedException('Sesi tidak valid atau kedaluwarsa');
            if (previous.revoked_at) {
                if (previous.replaced_by) {
                    await client.query(`UPDATE refresh_token SET revoked_at = COALESCE(revoked_at, now())
             WHERE token_family_id = $1`, [previous.token_family_id]);
                    await client.query('COMMIT');
                    transactionOpen = false;
                }
                throw new common_1.UnauthorizedException('Sesi tidak valid atau kedaluwarsa');
            }
            if (new Date(previous.expires_at).getTime() <= Date.now()) {
                throw new common_1.UnauthorizedException('Sesi tidak valid atau kedaluwarsa');
            }
            if (!(await this.isAccountActive(client, previous.id_pengguna, previous.role))) {
                await client.query(`UPDATE refresh_token SET revoked_at = COALESCE(revoked_at, now())
           WHERE token_family_id = $1`, [previous.token_family_id]);
                await client.query('COMMIT');
                transactionOpen = false;
                throw new common_1.UnauthorizedException('Sesi tidak valid atau kedaluwarsa');
            }
            const session = await this.createSessionInTransaction(client, { id: previous.id_pengguna, role: previous.role }, previous.token_family_id, ip, userAgent);
            const nextId = session.refreshRowId;
            await client.query(`UPDATE refresh_token SET revoked_at = now(), replaced_by = $2 WHERE id = $1`, [previous.id, nextId]);
            await client.query('COMMIT');
            transactionOpen = false;
            return session.result;
        }
        catch (error) {
            if (transactionOpen)
                await client.query('ROLLBACK');
            throw error;
        }
        finally {
            client.release();
        }
    }
    async logout(rawToken) {
        if (!rawToken)
            return;
        await this.pool.query(`UPDATE refresh_token
       SET revoked_at = COALESCE(revoked_at, now())
       WHERE token_family_id = (
         SELECT token_family_id FROM refresh_token WHERE token_hash = $1
       )`, [this.hashToken(rawToken)]);
    }
    async getCurrentUser(user) {
        const queryByRole = {
            MAHASISWA: `SELECT id_mahasiswa::text AS id, 'MAHASISWA'::text AS role, nama, email::text AS email
                  FROM mahasiswa WHERE id_mahasiswa = $1 AND status_aktif AND deleted_at IS NULL`,
            PSIKOLOG: `SELECT id_psikolog::text AS id, 'PSIKOLOG'::text AS role, nama, email::text AS email
                 FROM psikolog WHERE id_psikolog = $1 AND status_akun = 'AKTIF'`,
            DOSEN_ADMIN: `SELECT id_dosen::text AS id, 'DOSEN_ADMIN'::text AS role, nama, email::text AS email
                    FROM dosen_admin WHERE id_dosen = $1 AND aktif`,
        };
        const result = await this.pool.query(queryByRole[user.role], [user.id]);
        return result.rows[0] ?? null;
    }
    async issueSession(user, ip, userAgent) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const session = await this.createSessionInTransaction(client, user, (0, crypto_1.randomUUID)(), ip, userAgent);
            await client.query('COMMIT');
            return session.result;
        }
        catch (error) {
            await client.query('ROLLBACK');
            throw error;
        }
        finally {
            client.release();
        }
    }
    async createSessionInTransaction(client, user, familyId, ip, userAgent) {
        const refreshToken = (0, crypto_1.randomBytes)(32).toString('base64url');
        const refreshSeconds = this.refreshTokenTtlSeconds();
        const refreshResult = await client.query(`INSERT INTO refresh_token
         (id_pengguna, role, token_hash, token_family_id, expires_at, ip, user_agent)
       VALUES ($1, $2, $3, $4, now() + ($5 * interval '1 second'), $6, $7)
       RETURNING id::text`, [
            user.id,
            user.role,
            this.hashToken(refreshToken),
            familyId,
            refreshSeconds,
            ip ?? null,
            userAgent?.slice(0, 512) ?? null,
        ]);
        const accessToken = await this.jwt.signAsync({ role: user.role, jti: (0, crypto_1.randomUUID)() }, {
            subject: user.id,
        });
        return {
            refreshRowId: refreshResult.rows[0].id,
            result: {
                accessToken,
                expiresIn: ACCESS_TOKEN_SECONDS,
                user,
                refreshToken,
                refreshTokenExpiresIn: refreshSeconds,
            },
        };
    }
    async isAccountActive(client, id, role) {
        const sql = {
            MAHASISWA: `SELECT 1 FROM mahasiswa WHERE id_mahasiswa = $1 AND status_aktif AND deleted_at IS NULL`,
            PSIKOLOG: `SELECT 1 FROM psikolog WHERE id_psikolog = $1 AND status_akun = 'AKTIF'`,
            DOSEN_ADMIN: `SELECT 1 FROM dosen_admin WHERE id_dosen = $1 AND aktif`,
        };
        const result = await client.query(sql[role], [id]);
        return result.rowCount === 1;
    }
    verifyTotp(encryptedSecret, role, id, otp) {
        try {
            const table = role === 'PSIKOLOG' ? 'psikolog' : 'dosen_admin';
            const column = role === 'PSIKOLOG' ? 'id_psikolog' : 'id_dosen';
            const secretText = this.encryption
                .decrypt(encryptedSecret, `${table}:mfa_secret_enc:${id}`)
                .toString('utf8');
            const secret = decodeBase32(secretText);
            if (!/^\d{6}$/.test(otp))
                return false;
            const nowStep = Math.floor(Date.now() / 30_000);
            for (let drift = -1; drift <= 1; drift++) {
                const counter = Buffer.alloc(8);
                counter.writeBigUInt64BE(BigInt(nowStep + drift));
                const digest = (0, crypto_1.createHmac)('sha1', secret).update(counter).digest();
                const offset = digest[digest.length - 1] & 0x0f;
                const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
                const expected = Buffer.from(code.toString().padStart(6, '0'));
                if ((0, crypto_1.timingSafeEqual)(expected, Buffer.from(otp)))
                    return true;
            }
            return false;
        }
        catch {
            return false;
        }
    }
    hashToken(token) {
        return (0, crypto_1.createHash)('sha256').update(token, 'utf8').digest('hex');
    }
    refreshTokenTtlSeconds() {
        const raw = process.env.REFRESH_TOKEN_TTL_SECONDS;
        if (!raw)
            return DEFAULT_REFRESH_TOKEN_SECONDS;
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 60 || value > 30 * 24 * 60 * 60) {
            throw new Error('REFRESH_TOKEN_TTL_SECONDS harus berada antara 60 dan 2592000');
        }
        return value;
    }
};
exports.AuthService = AuthService;
exports.AuthService = AuthService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(database_module_1.DATABASE_POOL)),
    __metadata("design:paramtypes", [pg_1.Pool,
        jwt_1.JwtService,
        encryption_service_1.EncryptionService])
], AuthService);
function decodeBase32(value) {
    const normalized = value.replace(/=+$/g, '').replace(/\s+/g, '').toUpperCase();
    if (!normalized || !/^[A-Z2-7]+$/.test(normalized))
        throw new Error('Invalid TOTP secret');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const char of normalized)
        bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
    const bytes = [];
    for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
        bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
    }
    return Buffer.from(bytes);
}
//# sourceMappingURL=auth.service.js.map