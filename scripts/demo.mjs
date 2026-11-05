// Explicit preview: in-memory synthetic catalog. Disable every live provider action.
process.env.TRADELENS_DEMO='1';
process.env.TRADELENS_AUTOMATION='0';
for(const key of ['SHOPIFY_SHOP','SHOPIFY_ADMIN_TOKEN','SHOPIFY_WEBHOOK_SECRET','CJ_ACCESS_TOKEN','PRINTIFY_API_TOKEN','META_ADS_TOKEN','META_AD_ACCOUNT_ID','OPENAI_API_KEY','RESEND_API_KEY'])delete process.env[key];
await import('../server.mjs');
