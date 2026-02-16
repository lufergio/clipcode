/**
 * Genera un código corto alfanumérico sin caracteres ambiguos.
 * Ejemplo: A7F3
 */
export function generateCode(length: number = 4): string {
  const charset = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; 
  // Excluye O, I, 0, 1 para evitar confusión

  let code = "";
  for (let i = 0; i < length; i++) {
    const index = Math.floor(Math.random() * charset.length);
    code += charset[index];
  }

  return code;
}

/**
 * Genera un codigo numerico.
 * Ejemplo: 482901
 */
export function generateNumericCode(length: number = 6): string {
  const charset = "0123456789";

  let code = "";
  for (let i = 0; i < length; i++) {
    const index = Math.floor(Math.random() * charset.length);
    code += charset[index];
  }

  return code;
}
