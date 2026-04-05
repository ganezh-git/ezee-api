import app from './app';
import { environment } from './config/environment';
import { testConnections, closeAllPools } from './config/database';

async function start() {
  console.log('🔌 Testing database connections...');
  const results = await testConnections();

  results.forEach(({ name, status }) => {
    const icon = status === 'connected' ? '✅' : '❌';
    console.log(`  ${icon} ${name}: ${status}`);
  });

  const connected = results.filter(r => r.status === 'connected').length;
  console.log(`\n📊 ${connected}/${results.length} databases connected\n`);

  app.listen(environment.port, () => {
    console.log(`🚀 EZEE API running on http://localhost:${environment.port}`);
    console.log(`📦 Environment: ${environment.nodeEnv}`);
    console.log(`🌐 CORS origin: ${environment.cors.origin}`);
  });
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down...');
  await closeAllPools();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down...');
  await closeAllPools();
  process.exit(0);
});

start().catch((err) => {
  console.error('❌ Failed to start server:', err);
  process.exit(1);
});
