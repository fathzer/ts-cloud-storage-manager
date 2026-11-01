/**
 * Classification of an interactive-authentication failure. Each provider
 * maps its native errors (GIS error_callback, an ?error= parameter on a
 * redirect return, a polled popup that closed...) onto these kinds — the
 * UI wording lives in the consuming app instead of being recoded per provider.
 */
export type AuthFailureKind =
  | 'popupBlocked'  // the browser refused to open the consent window
  | 'popupClosed'   // the user closed the consent window before completion
  | 'accessDenied'  // consent/access refused on the provider side
  | 'error';        // anything else (network, provider outage, unknown)

export interface AuthFailure {
  kind: AuthFailureKind;
  /** Provider-side detail (e.g. OAuth error_description), for diagnosis. */
  detail?: string;
}
