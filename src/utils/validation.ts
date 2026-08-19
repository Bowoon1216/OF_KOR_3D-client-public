/**
 * 폼 검증 규칙은 서버(명세 3.1)와 맞춰 둡니다.
 * 클라이언트가 더 엄격하면 서버가 받아주는 계정을 만들지 못하고,
 * 더 느슨하면 422 를 받고 나서야 사용자에게 알려주게 됩니다.
 */

export const PASSWORD_MIN_LENGTH = 8;
/** bcrypt 가 72바이트를 넘는 입력을 조용히 잘라내기 때문에 서버가 64자로 제한합니다. */
export const PASSWORD_MAX_LENGTH = 64;
export const EMAIL_MAX_LENGTH = 254;
export const NAME_MAX_LENGTH = 64;

export const PASSWORD_RULE_TEXT = `${PASSWORD_MIN_LENGTH}~${PASSWORD_MAX_LENGTH}자`;

// 브라우저에서 형식만 거르고, 최종 판단(예약 TLD 거부 등)은 서버에 맡깁니다.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmail(email: string): string | undefined {
  if (!email) return '이메일을 입력해 주세요.';
  if (email.length > EMAIL_MAX_LENGTH) return `이메일은 ${EMAIL_MAX_LENGTH}자 이하여야 합니다.`;
  if (!EMAIL_PATTERN.test(email)) return '이메일 형식이 올바르지 않습니다.';
  return undefined;
}

export function validateName(name: string): string | undefined {
  if (!name) return '이름을 입력해 주세요.';
  if (name.length > NAME_MAX_LENGTH) return `이름은 ${NAME_MAX_LENGTH}자 이하여야 합니다.`;
  return undefined;
}

export function validatePassword(password: string): string | undefined {
  if (!password) return '비밀번호를 입력해 주세요.';
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `비밀번호는 ${PASSWORD_MIN_LENGTH}자 이상이어야 합니다.`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `비밀번호는 ${PASSWORD_MAX_LENGTH}자 이하여야 합니다.`;
  }
  return undefined;
}

export function validatePasswordConfirm(
  password: string,
  passwordConfirm: string,
): string | undefined {
  if (!passwordConfirm) return '비밀번호를 한 번 더 입력해 주세요.';
  if (password !== passwordConfirm) return '비밀번호가 일치하지 않습니다.';
  return undefined;
}
