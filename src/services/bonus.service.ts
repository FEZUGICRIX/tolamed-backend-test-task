import { Op, Transaction } from 'sequelize';

import { sequelize } from '../db';
import { BonusTransaction } from '../models/BonusTransaction';

type AppError = Error & { status?: number };

function createAppError(message: string, status: number): AppError {
  const error = new Error(message) as AppError;
  error.status = status;
  return error;
}

export async function getUserBalance(
  userId: string,
  transaction?: Transaction,
): Promise<number> {
  const now = new Date();

  // Получаем все транзакции пользователя
  const transactions = await BonusTransaction.findAll({
    where: { user_id: userId },
    transaction,
    lock: transaction ? Transaction.LOCK.UPDATE : undefined,
  });

  let balance = 0;

  for (const tx of transactions) {
    if (tx.type === 'accrual') {
      // Учитываем только не просроченные начисления
      if (!tx.expires_at || tx.expires_at > now) {
        balance += tx.amount;
      }
    } else if (tx.type === 'spend') {
      balance -= tx.amount;
    }
  }

  return balance;
}

interface SpendBonusResult {
  duplicated: boolean;
  transaction: BonusTransaction | null;
}

export async function spendBonus(
  userId: string,
  amount: number,
  requestId: string,
  payload: { amount: number },
): Promise<SpendBonusResult> {
  return await sequelize.transaction(
    { isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED },
    async (t) => {
      // Проверяем существующую транзакцию с таким requestId
      const existingTx = await BonusTransaction.findOne({
        where: {
          user_id: userId,
          request_id: requestId,
        },
        transaction: t,
      });

      if (existingTx) {
        // Проверяем совпадение payload
        if (existingTx.amount !== payload.amount || existingTx.type !== 'spend') {
          throw createAppError(
            'Request ID already used with different payload',
            409,
          );
        }

        // Это дубликат запроса - возвращаем успех
        return { duplicated: true, transaction: existingTx };
      }

      // Получаем баланс с блокировкой строк
      const balance = await getUserBalance(userId, t);

      if (balance < amount) {
        throw createAppError('Not enough bonus', 400);
      }

      // Создаем транзакцию списания
      const newTx = await BonusTransaction.create(
        {
          user_id: userId,
          type: 'spend',
          amount,
          expires_at: null,
          request_id: requestId,
        },
        { transaction: t },
      );

      return { duplicated: false, transaction: newTx };
    },
  );
}

export async function expireAccruals(): Promise<number> {
  const now = new Date();
  let expiredCount = 0;

  // Находим все просроченные начисления
  const expiredAccruals = await BonusTransaction.findAll({
    where: {
      type: 'accrual',
      expires_at: {
        [Op.lt]: now,
      },
    },
  });

  // Обрабатываем каждое начисление
  for (const accrual of expiredAccruals) {
    const requestId = `expire:${accrual.id}`;

    try {
      await sequelize.transaction(async (t) => {
        // Проверяем, не создали ли мы уже spend для этого начисления
        const existingSpend = await BonusTransaction.findOne({
          where: {
            user_id: accrual.user_id,
            request_id: requestId,
          },
          transaction: t,
        });

        if (existingSpend) {
          // Уже обработано, пропускаем
          return;
        }

        // Создаем spend-транзакцию на сумму просроченного начисления
        await BonusTransaction.create(
          {
            user_id: accrual.user_id,
            type: 'spend',
            amount: accrual.amount,
            expires_at: null,
            request_id: requestId,
          },
          { transaction: t },
        );

        expiredCount++;
      });
    } catch (error) {
      console.error(
        `Failed to expire accrual ${accrual.id}:`,
        error instanceof Error ? error.message : error,
      );
      throw error;
    }
  }

  return expiredCount;
}
