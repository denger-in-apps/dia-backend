import { UserRole } from './auth.types';
export declare const ROLES_KEY = "auth:roles";
export declare const Roles: (...roles: UserRole[]) => import("@nestjs/common").CustomDecorator<string>;
