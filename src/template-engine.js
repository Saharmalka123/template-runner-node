const { JSONPath } = require('jsonpath-plus');

class TemplateEngine {
  constructor(logger = console) {
    this.logger = logger;
  }

  async execute(template, parameters) {
    const context = {
      parameters: parameters || {},
      variables: {},
      stepResults: {}
    };

    for (const step of template.sequence || []) {
      this.logger.log(`Executing step: ${step.id}`);

      const stepResult = await this.executeStep(step, template, context);
      context.stepResults[step.id] = stepResult;

      if (!stepResult.success) {
        return {
          success: false,
          error: `Step '${step.id}' failed: ${stepResult.error}`,
          steps: context.stepResults
        };
      }
    }

    return { success: true, steps: context.stepResults };
  }

  async executeStep(step, template, context) {
    try {
      const { url, method, headers, body } = this.buildRequest(step, template, context);

      this.logger.log(`-----------> SENDING REQUEST (${step.id})`);
      this.logger.log(`--> Method: ${method}`);
      this.logger.log(`--> URL: ${url}`);
      this.logger.log(`--> Headers: ${JSON.stringify(headers)}`);
      if (body) this.logger.log(`--> Body: ${body}`);
      this.logger.log(`------------------------------------------`);

      const fetchOpts = {
        method,
        headers,
        ...(body ? { body } : {})
      };

      const response = await fetch(url, fetchOpts);
      const responseBody = await response.text();
      const responseHeaders = Object.fromEntries(response.headers.entries());
      
      // Node's fetch merges set-cookie into one entry; use getSetCookie for full values
      if (response.headers.getSetCookie && response.headers.getSetCookie().length > 0) {
        responseHeaders['set-cookie'] = response.headers.getSetCookie().join(', ');
      }

      this.logger.log(`<----------- RESPONSE for ${step.id}`);
      this.logger.log(`<-- Status: ${response.status}`);
      this.logger.log(`<-- Headers: ${JSON.stringify(responseHeaders)}`);
      this.logger.log(`<-- Body: ${responseBody.length > 500 ? responseBody.substring(0, 500) + '...' : responseBody}`);
      this.logger.log(`------------------------------------------`);

      // Extract data
      if (step.extract) {
        for (const extraction of step.extract) {
          this.extractData(extraction, response, responseHeaders, responseBody, context);
        }
        this.logger.log(`--- Context variables after step ${step.id} ---`);
        for (const [k, v] of Object.entries(context.variables)) {
          this.logger.log(`  ${k}: ${JSON.stringify(v)}`);
        }
        this.logger.log(`------------------------------------------`);
      }

      // Validate assertions
      if (step.assert) {
        for (const assertion of step.assert) {
          const isValid = this.validateAssertion(assertion, response, responseBody);
          this.logger.log(`Assertion ${assertion.source} ${assertion.op} ${JSON.stringify(assertion.value)}: ${isValid ? 'PASS' : 'FAIL'}`);
          if (!isValid) {
            return {
              success: false,
              error: `Assertion failed: ${assertion.source} ${assertion.op} ${JSON.stringify(assertion.value)}`,
              statusCode: response.status,
              requestBody: body,
              requestHeaders: headers,
              responseBody,
              responseHeaders
            };
          }
        }
      }

      return {
        success: true,
        statusCode: response.status,
        requestBody: body,
        requestHeaders: headers,
        responseBody,
        responseHeaders
      };
    } catch (ex) {
      this.logger.error(`Error executing step ${step.id}:`, ex);
      return { success: false, error: ex.message };
    }
  }

  buildRequest(step, template, context) {
    let requestConfig = {};

    // Apply baselines
    if (step.use && template.baselines) {
      for (const baselineName of step.use) {
        const baseline = template.baselines[baselineName];
        if (baseline) {
          this.mergeConfig(requestConfig, baseline);
        }
      }
    }

    // Apply step-specific config
    if (step.request) {
      this.mergeConfig(requestConfig, { request: step.request });
    }

    const method = requestConfig.method || 'GET';

    // Resolve base_url
    let baseUrl = this.substituteVariables(requestConfig.base_url || '', template, context);

    // Resolve url
    let url = this.substituteVariables(requestConfig.url || '', template, context, baseUrl);

    // Build full URL
    let fullUrl;
    if (url.startsWith('http://') || url.startsWith('https://')) {
      fullUrl = url;
    } else if (url.startsWith('/') && baseUrl) {
      fullUrl = baseUrl.replace(/\/$/, '') + url;
    } else if (baseUrl) {
      fullUrl = baseUrl.replace(/\/$/, '') + '/' + url.replace(/^\//, '');
    } else {
      fullUrl = url;
    }

    // Add query parameters
    if (requestConfig.query) {
      const queryJson = JSON.stringify(requestConfig.query);
      const substitutedQuery = this.substituteVariables(queryJson, template, context);
      const queryObj = JSON.parse(substitutedQuery);
      const params = new URLSearchParams();
      for (const [key, val] of Object.entries(queryObj)) {
        params.append(key, String(val));
      }
      const qs = params.toString();
      if (qs) {
        fullUrl += (fullUrl.includes('?') ? '&' : '?') + qs;
      }
    }

    // Headers
    let headers = {};
    if (requestConfig.headers) {
      for (const [key, val] of Object.entries(requestConfig.headers)) {
        headers[key] = this.substituteVariables(String(val), template, context);
      }
    }

    // Body
    let body = null;
    if (requestConfig.body) {
      const bodyJson = JSON.stringify(requestConfig.body);
      body = this.substituteVariables(bodyJson, template, context, baseUrl);
    }

    return { url: fullUrl, method, headers, body };
  }

  substituteVariables(text, template, context, currentBaseUrl) {
    if (!text) return text;

    // Replace {{ request.base_url }}
    text = text.replace(/\{\{\s*request\.base_url\s*\}\}/g, () => currentBaseUrl || '');

    // Replace {{ params.xxx }} or {{ params.xxx | default(value) }}
    text = text.replace(/"?\{\{\s*params\.([^\s}|]+)(\s*\|\s*default\(([^)]+)\))?\s*\}\}"?/g, (match, path, _hasDefault, defaultValue) => {
      const hasQuotes = match.startsWith('"') && match.endsWith('"');
      const value = this.getNestedValue(context.parameters, path);

      if ((value === undefined || value === null || value === '') && defaultValue) {
        if (defaultValue === 'now_ms') {
          const ts = String(Date.now());
          return hasQuotes ? `"${ts}"` : ts;
        }
        return hasQuotes ? `"${defaultValue}"` : defaultValue;
      }

      if (value === undefined || value === null) return hasQuotes ? '""' : '';

      // If value is object/array, return raw JSON (no wrapping quotes)
      if (typeof value === 'object') {
        return JSON.stringify(value);
      }

      // Primitive value - if original had quotes, keep them
      if (hasQuotes) {
        return `"${String(value)}"`;
      }
      return String(value);
    });

    // Replace {{ vars.xxx }} or {{ vars.xxx[N] }}
    text = text.replace(/"?\{\{\s*vars\.([^\s\[\]]+)(\[(\d+)\])?\s*\}\}"?/g, (match, varName, _indexPart, indexStr) => {
      const hasQuotes = match.startsWith('"') && match.endsWith('"');
      const value = context.variables[varName];

      if (value === undefined || value === null) {
        return hasQuotes ? '""' : '';
      }

      let result;
      if (indexStr !== undefined && Array.isArray(value)) {
        const idx = parseInt(indexStr);
        result = idx < value.length ? value[idx] : '';
      } else {
        result = value;
      }

      if (typeof result === 'object') {
        return JSON.stringify(result);
      }

      return hasQuotes ? `"${result}"` : String(result);
    });

    // Replace {{ envs[params.env].xxx }}
    text = text.replace(/\{\{\s*envs\[params\.env\]\.([^\s}]+)\s*\}\}/g, (_match, key) => {
      const env = context.parameters.env;
      if (template.envs && template.envs[env] && template.envs[env][key]) {
        return template.envs[env][key];
      }
      return '';
    });

    // Replace {{ steps.xxx.response.body.Data.xxx }}
    text = text.replace(/\{\{\s*steps\.([^.]+)\.response\.body\.([^\s}]+)\s*\}\}/g, (_match, stepId, path) => {
      const stepResult = context.stepResults[stepId];
      if (stepResult && stepResult.responseBody) {
        try {
          const json = JSON.parse(stepResult.responseBody);
          return String(this.getNestedValue(json, path) || '');
        } catch { }
      }
      return '';
    });

    return text;
  }

  getNestedValue(obj, path) {
    const parts = path.split('.');
    let current = obj;
    for (const part of parts) {
      if (current == null || typeof current !== 'object') return undefined;
      current = current[part];
    }
    return current;
  }

  extractData(extraction, response, responseHeaders, responseBody, context) {
    try {
      if (extraction.from === 'header') {
        // Headers come as a flat object; need to find the header (case-insensitive)
        const headerName = extraction.name.toLowerCase();
        let headerValue = '';
        
        // Check response headers - try both the headers object and set-cookie specially
        if (headerName === 'set-cookie') {
          // set-cookie may be combined in the headers entries
          headerValue = responseHeaders['set-cookie'] || '';
        } else {
          for (const [key, val] of Object.entries(responseHeaders)) {
            if (key.toLowerCase() === headerName) {
              headerValue = val;
              break;
            }
          }
        }

        if (headerValue && extraction.pattern) {
          const regex = new RegExp(extraction.pattern);
          const match = regex.exec(headerValue);
          if (match && match[1]) {
            context.variables[extraction.as] = match[1];
            this.logger.log(`Extracted ${extraction.as} = ${match[1]}`);
          }
        }
      } else if (extraction.from === 'jsonpath') {
        if (responseBody) {
          try {
            const json = JSON.parse(responseBody);
            const results = JSONPath({ path: extraction.path, json });

            if (results && results.length > 1) {
              context.variables[extraction.as] = results;
              this.logger.log(`Extracted ${extraction.as} = [${results.join(', ')}]`);
            } else if (results && results.length === 1) {
              context.variables[extraction.as] = results[0];
              this.logger.log(`Extracted ${extraction.as} = ${JSON.stringify(results[0])}`);
            } else if (extraction.required) {
              this.logger.warn(`Required extraction ${extraction.as} from path ${extraction.path} returned no matches`);
            }
          } catch (ex) {
            this.logger.warn(`Failed to parse JSON for extraction ${extraction.as}:`, ex.message);
          }
        }
      }
    } catch (ex) {
      this.logger.warn(`Failed to extract ${extraction.as}:`, ex.message);
    }
  }

  validateAssertion(assertion, response, responseBody) {
    try {
      if (assertion.source === 'status') {
        const expected = Number(assertion.value);
        return assertion.op === 'equals' && response.status === expected;
      }

      if (assertion.source === 'header') {
        const headerName = assertion.name.toLowerCase();
        let headerValue = '';
        
        // Special handling for set-cookie (multiple values)
        if (headerName === 'set-cookie' && response.headers.getSetCookie) {
          headerValue = response.headers.getSetCookie().join(', ');
        } else {
          const headers = Object.fromEntries(response.headers.entries());
          for (const [key, val] of Object.entries(headers)) {
            if (key.toLowerCase() === headerName) {
              headerValue = val;
              break;
            }
          }
        }
        
        if (assertion.op === 'contains') {
          return headerValue.includes(String(assertion.value));
        }
        return false;
      }

      if (assertion.source === 'jsonpath') {
        const json = JSON.parse(responseBody);
        const results = JSONPath({ path: assertion.path, json });

        if (!results || results.length === 0) return false;

        const actual = results[0];
        if (assertion.op === 'equals') {
          return this.deepEquals(actual, assertion.value);
        }
        return false;
      }
    } catch (ex) {
      this.logger.warn('Assertion validation failed:', ex.message);
      return false;
    }
    return false;
  }

  deepEquals(a, b) {
    if (a === b) return true;
    if (a == null && b == null) return true;
    if (a == null || b == null) return false;

    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      return a.every((val, i) => this.deepEquals(val, b[i]));
    }

    if (typeof a === 'object' && typeof b === 'object') {
      const keysA = Object.keys(a);
      const keysB = Object.keys(b);
      if (keysA.length !== keysB.length) return false;
      return keysA.every(key => this.deepEquals(a[key], b[key]));
    }

    // Loose comparison for numbers/strings
    return String(a) === String(b);
  }

  mergeConfig(target, source) {
    // Source may be { request: { ... } } (baseline format) or direct properties
    const props = source.request || source;

    for (const [key, val] of Object.entries(props)) {
      if (key === 'headers' && target.headers) {
        target.headers = { ...target.headers, ...val };
      } else {
        target[key] = val;
      }
    }
  }
}

module.exports = { TemplateEngine };
