import { describe, expect, it } from 'vitest';
import {
  acceptInviteInputSchema,
  createInviteInputSchema,
  generateInviteToken,
} from './invitationService';

describe('Invitation Service & Schemas', () => {
  it('generates a 64-character hexadecimal secure token', () => {
    const token = generateInviteToken();
    expect(typeof token).toBe('string');
    expect(token).toHaveLength(64);
    expect(/^[a-f0-9]{64}$/.test(token)).toBe(true);
  });

  it('validates valid invite input with default and explicit roles', () => {
    const defaultRoleInput = {
      email: 'novo.membro@empresa.com',
    };
    const parsedDefault = createInviteInputSchema.safeParse(defaultRoleInput);
    expect(parsedDefault.success).toBe(true);
    if (parsedDefault.success) {
      expect(parsedDefault.data.papel).toBe('member');
    }

    const explicitAdminInput = {
      email: 'gestor@empresa.com',
      papel: 'admin',
    };
    const parsedAdmin = createInviteInputSchema.safeParse(explicitAdminInput);
    expect(parsedAdmin.success).toBe(true);
  });

  it('rejects invalid invite input (malformed email or illegal role like owner)', () => {
    const invalidEmailInput = {
      email: 'not-an-email',
      papel: 'member',
    };
    expect(createInviteInputSchema.safeParse(invalidEmailInput).success).toBe(false);

    const illegalOwnerInput = {
      email: 'owner@empresa.com',
      papel: 'owner', // direct invite as owner is forbidden
    };
    expect(createInviteInputSchema.safeParse(illegalOwnerInput).success).toBe(false);
  });

  it('validates accept invite token input', () => {
    const validInput = {
      token: 'a'.repeat(64),
    };
    expect(acceptInviteInputSchema.safeParse(validInput).success).toBe(true);

    const invalidShortInput = {
      token: 'short',
    };
    expect(acceptInviteInputSchema.safeParse(invalidShortInput).success).toBe(false);
  });
});
