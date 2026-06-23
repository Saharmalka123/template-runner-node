const BLOB_BASE_URL = 'https://testtenbis.blob.core.windows.net/sahar-testing/createOrder';

class TemplateLoader {
  constructor(baseUrl = BLOB_BASE_URL) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async loadTemplate(templateRef) {
    // templateRef examples: "orderCreateASAPPOOL@10", "orders/orderCreateASAP@10"
    const cleanRef = templateRef.replace(/^orders\//, '');

    // Try fetching directly as <ref>.json
    const directUrl = `${this.baseUrl}/${cleanRef}.json`;
    console.log(`[TemplateLoader] Trying: ${directUrl}`);

    const res = await fetch(directUrl);
    if (res.ok) {
      let text = await res.text();
      // Strip BOM if present
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      const template = JSON.parse(text);
      console.log(`[TemplateLoader] Loaded template: ${cleanRef}`);
      return template;
    }

    // Try with "orders/" prefix
    const prefixedUrl = `${this.baseUrl}/orders/${cleanRef}.json`;
    console.log(`[TemplateLoader] Trying with prefix: ${prefixedUrl}`);

    const res2 = await fetch(prefixedUrl);
    if (res2.ok) {
      let text = await res2.text();
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      const template = JSON.parse(text);
      console.log(`[TemplateLoader] Loaded template: orders/${cleanRef}`);
      return template;
    }

    console.log(`[TemplateLoader] Template not found: ${templateRef}`);
    return null;
  }

  /**
   * List available templates from the blob.
   * Since Azure Blob public containers don't support listing without SAS,
   * we maintain a known list that can be extended.
   */
  async listTemplates() {
    // Try fetching an index file if it exists
    try {
      const indexUrl = `${this.baseUrl}/index.json`;
      const res = await fetch(indexUrl);
      if (res.ok) {
        return await res.json();
      }
    } catch {}

    // Fallback: return empty - the client will need to provide template_ref manually
    return [];
  }
}

module.exports = { TemplateLoader, BLOB_BASE_URL };
