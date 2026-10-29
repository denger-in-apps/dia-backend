import { SetMetadata } from '@nestjs/common';
import { UserRole } from './auth.types';

export const ROLES_KEY = 'auth:roles';
export const Roles = (...roles: UserRole[]) => {
  if (!roles.length || roles.some((role) => !USER_ROLES.includes(role))) {
    throw new Error('@Roles() harus memiliki setidaknya satu role yang valid');
  }
  return SetMetadata(ROLES_KEY, [...new Set(roles)]);
};
