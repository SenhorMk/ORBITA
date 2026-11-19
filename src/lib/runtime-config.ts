type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

/** Redacted result returned when a required runtime variable is invalid. */
export type InvalidRuntimeConfiguration = {
  readonly _tag: 'InvalidRuntimeConfiguration';
  readonly variable:
    | 'NEXT_PUBLIC_SUPABASE_ANON_KEY'
    | 'NEXT_PUBLIC_SUPABASE_URL'
    | 'SUPABASE_SERVICE_ROLE_KEY';
};

/** Valid configuration required by the browser Supabase adapter. */
export type SupabaseBrowserConfigurationResult =
  | InvalidRuntimeConfiguration
  | {
      readonly _tag: 'ValidSupabaseBrowserConfiguration';
      readonly anonKey: string;
      readonly url: string;
    };

/** Valid configuration required by the privileged server Supabase adapter. */
export type SupabaseServerConfigurationResult =
  | InvalidRuntimeConfiguration
  | {
      readonly _tag: 'ValidSupabaseServerConfiguration';
      readonly serviceRoleKey: string;
      readonly url: string;
    };

function isValidSupabaseUrl(value: string | undefined, environment: RuntimeEnvironment): value is string {
  if (!value || /placeholder|seu-projeto/iu.test(value)) return false;

  try {
    const url = new URL(value);
    if (environment.NODE_ENV === 'development' && environment.NEXT_PUBLIC_ORBITA_DEMO_LOCAL === 'true'
      && value === 'http://127.0.0.1:55821') return true;
    return url.protocol === 'https:' && url.hostname.endsWith('.supabase.co');
  } catch {
    return false;
  }
}

function isValidKey(value: string | undefined): value is string {
  return Boolean(
    value
    && value.length >= 20
    && !/placeholder|replace-me|your[-_]/iu.test(value),
  );
}

/** Parse browser Supabase configuration without substituting fallback credentials. */
export function readSupabaseBrowserConfiguration(
  environment: RuntimeEnvironment = process.env,
): SupabaseBrowserConfigurationResult {
  const url = environment.NEXT_PUBLIC_SUPABASE_URL;
  if (!isValidSupabaseUrl(url, environment)) {
    return {
      _tag: 'InvalidRuntimeConfiguration',
      variable: 'NEXT_PUBLIC_SUPABASE_URL',
    };
  }

  const anonKey = environment.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!isValidKey(anonKey)) {
    return {
      _tag: 'InvalidRuntimeConfiguration',
      variable: 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    };
  }

  return { _tag: 'ValidSupabaseBrowserConfiguration', anonKey, url };
}

/** Parse privileged Supabase configuration without reading ad-hoc environment files. */
export function readSupabaseServerConfiguration(
  environment: RuntimeEnvironment = process.env,
): SupabaseServerConfigurationResult {
  const url = environment.NEXT_PUBLIC_SUPABASE_URL;
  if (!isValidSupabaseUrl(url, environment)) {
    return {
      _tag: 'InvalidRuntimeConfiguration',
      variable: 'NEXT_PUBLIC_SUPABASE_URL',
    };
  }

  const serviceRoleKey = environment.SUPABASE_SERVICE_ROLE_KEY;
  if (!isValidKey(serviceRoleKey)) {
    return {
      _tag: 'InvalidRuntimeConfiguration',
      variable: 'SUPABASE_SERVICE_ROLE_KEY',
    };
  }

  return {
    _tag: 'ValidSupabaseServerConfiguration',
    serviceRoleKey,
    url,
  };
}
