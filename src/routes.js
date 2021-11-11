import Router from 'koa-router';

const router = new Router;

router.get('/health', async ctx => {
    ctx.body = '';
});

export default router;
