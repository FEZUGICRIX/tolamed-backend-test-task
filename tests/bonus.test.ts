import { Sequelize } from 'sequelize';
import { BonusTransaction, initBonusTransactionModel } from '../src/models/BonusTransaction';
import { User, initUserModel } from '../src/models/User';
import { spendBonus, getUserBalance, expireAccruals } from '../src/services/bonus.service';

let sequelize: Sequelize;

beforeAll(async () => {
  // Используем тестовую БД Postgres
  const dbUrl = process.env.DATABASE_URL || 'postgres://app:app@localhost:5432/appdb';

  sequelize = new Sequelize(dbUrl, {
    logging: false,
  });

  initUserModel(sequelize);
  initBonusTransactionModel(sequelize);

  await sequelize.sync({ force: false });
});

afterAll(async () => {
  await sequelize.close();
});

beforeEach(async () => {
  // Очищаем таблицы перед каждым тестом
  await BonusTransaction.destroy({ where: {}, force: true });
  await User.destroy({ where: {}, force: true });
});

describe('Bonus System Tests', () => {
  describe('1. Идемпотентность запросов', () => {
    it('повторный запрос с тем же requestId не создает второе списание', async () => {
      const user = await User.create({ name: 'Test User' });

      await BonusTransaction.create({
        user_id: user.id,
        type: 'accrual',
        amount: 1000,
        expires_at: null,
        request_id: null,
      });

      const requestId = 'test-request-123';
      const payload = { amount: 100 };

      const result1 = await spendBonus(user.id, 100, requestId, payload);
      expect(result1.duplicated).toBe(false);

      const balance1 = await getUserBalance(user.id);
      expect(balance1).toBe(900);

      const result2 = await spendBonus(user.id, 100, requestId, payload);
      expect(result2.duplicated).toBe(true);

      const balance2 = await getUserBalance(user.id);
      expect(balance2).toBe(900);

      const spendTransactions = await BonusTransaction.count({
        where: { user_id: user.id, type: 'spend' },
      });
      expect(spendTransactions).toBe(1);
    });

    it('тот же requestId с другим payload возвращает 409', async () => {
      const user = await User.create({ name: 'Test User' });

      await BonusTransaction.create({
        user_id: user.id,
        type: 'accrual',
        amount: 1000,
        expires_at: null,
        request_id: null,
      });

      const requestId = 'test-request-456';

      await spendBonus(user.id, 100, requestId, { amount: 100 });

      await expect(
        spendBonus(user.id, 200, requestId, { amount: 200 }),
      ).rejects.toThrow('Request ID already used with different payload');
    });
  });

  describe('2. Просроченные начисления не учитываются в балансе', () => {
    it('expired accrual не участвует в доступном балансе', async () => {
      const user = await User.create({ name: 'Test User' });

      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      await BonusTransaction.create({
        user_id: user.id,
        type: 'accrual',
        amount: 500,
        expires_at: yesterday,
        request_id: null,
      });

      await BonusTransaction.create({
        user_id: user.id,
        type: 'accrual',
        amount: 300,
        expires_at: tomorrow,
        request_id: null,
      });

      await BonusTransaction.create({
        user_id: user.id,
        type: 'accrual',
        amount: 200,
        expires_at: null,
        request_id: null,
      });

      const balance = await getUserBalance(user.id);
      expect(balance).toBe(500);
    });

    it('нельзя списать больше доступного баланса (с учетом expired)', async () => {
      const user = await User.create({ name: 'Test User' });

      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

      await BonusTransaction.create({
        user_id: user.id,
        type: 'accrual',
        amount: 1000,
        expires_at: yesterday,
        request_id: null,
      });

      await expect(
        spendBonus(user.id, 100, 'req-1', { amount: 100 }),
      ).rejects.toThrow('Not enough bonus');
    });
  });

  describe('3. Конкурентные списания не приводят к отрицательному балансу', () => {
    it('параллельные запросы не создают двойное списание', async () => {
      const user = await User.create({ name: 'Test User' });

      await BonusTransaction.create({
        user_id: user.id,
        type: 'accrual',
        amount: 1000,
        expires_at: null,
        request_id: null,
      });

      // Запускаем 5 параллельных запросов на списание по 300
      const promises = Array.from({ length: 5 }, (_, i) =>
        spendBonus(user.id, 300, `concurrent-req-${i}`, { amount: 300 }).catch(
          (err) => err,
        ),
      );

      const results = await Promise.all(promises);

      // Проверяем финальный баланс - главное, что он не отрицательный
      const finalBalance = await getUserBalance(user.id);
      expect(finalBalance).toBeGreaterThanOrEqual(0);
      expect(finalBalance).toBeLessThanOrEqual(1000);

      // Проверяем количество успешных списаний
      const spendCount = await BonusTransaction.count({
        where: { user_id: user.id, type: 'spend' },
      });

      // Должно быть максимум 3 списания (1000 / 300 = 3.33)
      expect(spendCount).toBeLessThanOrEqual(3);

      // Баланс должен соответствовать количеству списаний
      expect(finalBalance).toBe(1000 - spendCount * 300);

      // Проверяем, что были отклоненные запросы
      const failedRequests = results.filter(
        (r) => r && r.message?.includes('Not enough bonus'),
      );
      expect(failedRequests.length).toBeGreaterThan(0);
    });
  });

  describe('4. Очередь: повторная обработка не создает дубли', () => {
    it('expireAccruals создает spend-транзакции для просроченных начислений', async () => {
      const user = await User.create({ name: 'Test User' });

      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const accrual = await BonusTransaction.create({
        user_id: user.id,
        type: 'accrual',
        amount: 500,
        expires_at: yesterday,
        request_id: null,
      });

      const expiredCount = await expireAccruals();
      expect(expiredCount).toBe(1);

      const spendTx = await BonusTransaction.findOne({
        where: {
          user_id: user.id,
          type: 'spend',
          request_id: `expire:${accrual.id}`,
        },
      });

      expect(spendTx).not.toBeNull();
      expect(spendTx?.amount).toBe(500);
    });

    it('повторная обработка не создает дубли', async () => {
      const user = await User.create({ name: 'Test User' });

      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

      await BonusTransaction.create({
        user_id: user.id,
        type: 'accrual',
        amount: 500,
        expires_at: yesterday,
        request_id: null,
      });

      const count1 = await expireAccruals();
      expect(count1).toBe(1);

      const count2 = await expireAccruals();
      expect(count2).toBe(0);

      const spendCount = await BonusTransaction.count({
        where: { user_id: user.id, type: 'spend' },
      });
      expect(spendCount).toBe(1);
    });

    it('несколько просроченных начислений обрабатываются корректно', async () => {
      const user = await User.create({ name: 'Test User' });

      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

      await BonusTransaction.create({
        user_id: user.id,
        type: 'accrual',
        amount: 100,
        expires_at: yesterday,
        request_id: null,
      });

      await BonusTransaction.create({
        user_id: user.id,
        type: 'accrual',
        amount: 200,
        expires_at: yesterday,
        request_id: null,
      });

      await BonusTransaction.create({
        user_id: user.id,
        type: 'accrual',
        amount: 300,
        expires_at: yesterday,
        request_id: null,
      });

      const expiredCount = await expireAccruals();
      expect(expiredCount).toBe(3);

      const spendCount = await BonusTransaction.count({
        where: { user_id: user.id, type: 'spend' },
      });
      expect(spendCount).toBe(3);
    });
  });
});
