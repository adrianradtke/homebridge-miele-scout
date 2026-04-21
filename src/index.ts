/**
 * HomeBridge plugin entry point.
 *
 * This file registers the platform with HomeBridge so it knows which
 * constructor to call and which names to use in config.json.
 *
 * The `pluginAlias` here MUST match the value in config.schema.json.
 */

import { API } from 'homebridge';
import { MieleScoutPlatform } from './platform';

export const PLUGIN_NAME = 'homebridge-miele-scout';
export const PLATFORM_NAME = 'MieleScout';

/**
 * This method is called by HomeBridge to register the plugin.
 * It receives the HomeBridge API instance and registers our platform class.
 */
export default (api: API): void => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, MieleScoutPlatform);
};
