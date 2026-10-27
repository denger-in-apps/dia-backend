import { UserRole } from '../auth.types';
export declare class StaffLoginDto {
    role: Extract<UserRole, 'PSIKOLOG' | 'DOSEN_ADMIN'>;
    email: string;
    password: string;
    otp?: string;
}
