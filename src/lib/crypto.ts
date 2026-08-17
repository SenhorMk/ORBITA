import crypto from 'crypto';

/** Result of validating the server-side encryption configuration. */
export type EncryptionConfigurationResult =
  | { _tag: 'EncryptionConfigured' }
  | {
      _tag: 'InvalidEncryptionConfiguration';
      reason: 'missing' | 'invalid-format';
    };

/** Validate the runtime key without returning or logging its value. */
export function checkEncryptionConfiguration(): EncryptionConfigurationResult {
  const encodedKey = process.env.ENCRYPTION_KEY;
  if (!encodedKey) {
    return { _tag: 'InvalidEncryptionConfiguration', reason: 'missing' };
  }

  if (!/^[0-9a-f]{64}$/i.test(encodedKey)) {
    return { _tag: 'InvalidEncryptionConfiguration', reason: 'invalid-format' };
  }

  return { _tag: 'EncryptionConfigured' };
}

function readEncryptionKey(): Buffer {
  const encodedKey = process.env.ENCRYPTION_KEY;
  if (!encodedKey) {
    throw new Error('Variável ENCRYPTION_KEY é obrigatória para criptografia.');
  }

  if (!/^[0-9a-f]{64}$/i.test(encodedKey)) {
    throw new Error('Variável ENCRYPTION_KEY deve conter exatamente 32 bytes em hexadecimal.');
  }

  return Buffer.from(encodedKey, 'hex');
}

/** Encrypt a non-empty secret using AES-256-GCM. */
export function encrypt(text: string | null | undefined): string | null {
  if (!text) return null;

  const key = readEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag().toString('hex');
  
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/** Decrypt an AES-256-GCM value, preserving only unmarked legacy plaintext. */
export function decrypt(encryptedText: string | null | undefined): string | null {
  if (!encryptedText) return null;
  if (!encryptedText.includes(':')) {
    // Legacy rows are plaintext only when they have no encrypted-envelope marker.
    return encryptedText;
  }

  try {
    const key = readEncryptionKey();
    const parts = encryptedText.split(':');
    if (parts.length !== 3) return null;
    
    const [ivHex, authTagHex, dataHex] = parts;

    if (
      !/^[0-9a-f]{24}$/i.test(ivHex) ||
      !/^[0-9a-f]{32}$/i.test(authTagHex) ||
      !/^(?:[0-9a-f]{2})+$/i.test(dataHex)
    ) {
      return null;
    }

    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(dataHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch {
    console.error('Falha ao autenticar dado criptografado.');
    return null;
  }
}
