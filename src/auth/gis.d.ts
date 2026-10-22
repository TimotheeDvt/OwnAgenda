// Minimal type declarations for the parts of Google Identity Services (token model) we use.
// https://developers.google.com/identity/oauth2/web/reference/js-reference

declare namespace google.accounts.oauth2 {
  interface TokenResponse {
    access_token: string;
    expires_in: number | string;
    scope: string;
    token_type: string;
    error?: string;
    error_description?: string;
    error_uri?: string;
  }

  interface ClientConfigError {
    type: 'popup_failed_to_open' | 'popup_closed' | 'unknown';
    message?: string;
  }

  interface TokenClientConfig {
    client_id: string;
    scope: string;
    callback: (response: TokenResponse) => void;
    error_callback?: (error: ClientConfigError) => void;
    prompt?: '' | 'none' | 'consent' | 'select_account';
    hint?: string;
  }

  interface OverridableTokenClientConfig {
    prompt?: '' | 'none' | 'consent' | 'select_account';
    hint?: string;
    scope?: string;
  }

  interface TokenClient {
    requestAccessToken(overrideConfig?: OverridableTokenClientConfig): void;
  }

  function initTokenClient(config: TokenClientConfig): TokenClient;
  function hasGrantedAllScopes(response: TokenResponse, ...scopes: string[]): boolean;
  function revoke(accessToken: string, done?: () => void): void;
}
