"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SsoProviderDeniedException = exports.SSO_STRATEGY = void 0;
const common_1 = require("@nestjs/common");
exports.SSO_STRATEGY = Symbol('SSO_STRATEGY');
class SsoProviderDeniedException extends common_1.UnauthorizedException {
    constructor() {
        super('Login SSO dibatalkan oleh penyedia identitas');
    }
}
exports.SsoProviderDeniedException = SsoProviderDeniedException;
//# sourceMappingURL=sso-strategy.js.map