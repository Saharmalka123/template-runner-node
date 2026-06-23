const express = require('express');
const path = require('path');
const { TemplateEngine } = require('./template-engine');
const { TemplateLoader } = require('./template-loader');

const app = express();
app.use(express.json({ limit: '10mb' }));

const loader = new TemplateLoader();
const engine = new TemplateEngine();

// Serve static client UI
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// Get template definition (so the client can show params_schema)
app.get('/templates/:templateRef', async (req, res) => {
  try {
    const template = await loader.loadTemplate(req.params.templateRef);
    if (!template) {
      return res.status(404).json({ ok: false, error: `Template not found: ${req.params.templateRef}` });
    }
    res.json(template);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Run a template
app.post('/run-template', async (req, res) => {
  try {
    const { template_ref, params } = req.body;

    if (!template_ref) {
      return res.status(400).json({ ok: false, error: 'template_ref is required' });
    }

    console.log(`[Server] Running template: ${template_ref}`);

    const template = await loader.loadTemplate(template_ref);
    if (!template) {
      return res.status(404).json({ ok: false, error: `Template not found: ${template_ref}` });
    }

    const result = await engine.execute(template, params || {});

    if (result.success) {
      const stepKeys = Object.keys(result.steps || {});
      const lastStepName = stepKeys[stepKeys.length - 1];
      const lastStep = result.steps[lastStepName];

      let responseData = null;
      if (lastStep?.responseBody) {
        try { responseData = JSON.parse(lastStep.responseBody); } catch { responseData = lastStep.responseBody; }
      }

      res.json({
        ok: true,
        template_ref,
        last_successful_step: lastStepName,
        response: responseData
      });
    } else {
      const stepKeys = Object.keys(result.steps || {});
      const lastStepName = stepKeys[stepKeys.length - 1];
      const failedStep = result.steps[lastStepName];

      let responseData = null;
      if (failedStep?.responseBody) {
        try { responseData = JSON.parse(failedStep.responseBody); } catch { responseData = failedStep.responseBody; }
      }

      const statusCode = determineStatusCode(result.error, lastStepName, failedStep?.responseBody);

      res.status(statusCode).json({
        ok: false,
        error: result.error,
        last_successful_step: lastStepName,
        response: responseData
      });
    }
  } catch (err) {
    console.error('[Server] Error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

function determineStatusCode(error, stepName, responseBody) {
  if (!error) return 500;

  if (stepName === 'GetUser' && error.includes('Assertion failed')) return 401;

  if (responseBody) {
    if (responseBody.includes('"Success":false') || responseBody.includes('"Success": false') ||
        responseBody.includes('InvalidParameters')) {
      return 422;
    }
  }

  if (error.includes('Assertion failed: status')) return 502;
  if (error.includes('not found') || error.includes('Not found')) return 404;

  return 500;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Template Runner listening on http://localhost:${PORT}`);
  console.log(`Client UI: http://localhost:${PORT}`);
});
