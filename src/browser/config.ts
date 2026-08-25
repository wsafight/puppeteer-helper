import { invariant } from '../utils';

export interface BrowserConfig {
  executablePath: string;
  headless?: boolean | 'shell';
  launchArgs?: string[];
}

/** singleton */
let finalConfig: BrowserConfig;

const DEFAULT_CONFIG: BrowserConfig = {
  executablePath: '',
  headless: true,
  launchArgs: [],
};

/** @deprecated Use createRenderer with instance-level options. */
export const configureBrowserConfig = ({
  executablePath,
  headless = true,
  launchArgs = [],
} = DEFAULT_CONFIG) => {
  /**  A browser location that actually works  */
  invariant(
    typeof executablePath !== 'string' || !executablePath,
    'executablePath of chrome cannot be empty',
  );

  finalConfig = {
    executablePath,
    headless,
    launchArgs,
  };
  Object.freeze(finalConfig);
};

export const getBrowserConfig = () => {
  invariant(!finalConfig, 'configureBrowserConfig must be called first');
  return finalConfig;
};
