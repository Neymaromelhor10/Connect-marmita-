/** Traduz erros técnicos de autenticação e cadastro em mensagens claras para o usuário. */
export function authErrorMessage(error: unknown): string {
  const raw = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();

  if (
    raw.includes("supabase_config_missing") ||
    raw.includes("missing supabase environment variable")
  ) {
    return "Configuração do Supabase ausente no ambiente (.env). Verifique VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY na pasta marmita-connect/.env.";
  }

  if (raw.includes("supabase_url_invalid")) {
    return "URL do Supabase inválida ou com valor de exemplo no .env (VITE_SUPABASE_URL).";
  }

  if (raw.includes("setup_company_failed")) {
    return "Usuário autenticado, mas o servidor não conseguiu salvar o cadastro da marmitaria no banco de dados. Verifique SUPABASE_SERVICE_ROLE_KEY e o status do servidor.";
  }

  if (raw.includes("invalid login credentials")) return "E-mail ou senha incorretos.";
  if (raw.includes("email not confirmed")) return "Confirme seu e-mail antes de entrar.";
  if (raw.includes("user already registered") || raw.includes("already been registered"))
    return "Este e-mail já está cadastrado. Faça login.";
  if (raw.includes("pwned") || raw.includes("compromised") || raw.includes("easy to guess"))
    return "Essa senha é muito comum e insegura. Escolha outra mais forte.";
  if (raw.includes("password should be at least") || raw.includes("weak"))
    return "A senha precisa ter pelo menos 6 caracteres e não pode ser muito comum.";

  if (raw.includes("invalid email") || raw.includes("unable to validate email"))
    return "Digite um e-mail válido.";
  if (raw.includes("rate limit") || raw.includes("too many"))
    return "Muitas tentativas. Aguarde alguns minutos e tente de novo.";
  if (raw.includes("same password"))
    return "A nova senha precisa ser diferente da anterior.";
  if (raw.includes("expired") || raw.includes("invalid token"))
    return "O link expirou. Solicite a recuperação de senha novamente.";
  if (
    raw.includes("failed to fetch") ||
    raw.includes("networkerror") ||
    raw.includes("load failed") ||
    raw.includes("econnrefused") ||
    raw.includes("err_name_not_resolved") ||
    raw.includes("network")
  ) {
    return "Sem conexão com o servidor. Verifique se o backend e o projeto Supabase estão ativos e se o .env está na raiz marmita-connect/.env.";
  }

  return "Não foi possível entrar. Tente novamente.";
}
