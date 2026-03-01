#!/bin/bash

# Скрипт для очистки данных и повторной загрузки seed.sql

echo "🗑️  Удаляем все данные из таблиц..."
docker compose exec postgres psql -U app -d appdb -c "
DELETE FROM bonus_transactions;
DELETE FROM users;
"

echo ""
echo "🌱 Загружаем seed данные..."
docker compose exec -T postgres psql -U app -d appdb < db/seed.sql 2>&1 | grep -E "(INSERT|ERROR)"

echo ""
echo "✅ База данных очищена и seed данные загружены!"
echo ""
echo "📊 Текущее состояние:"
docker compose exec postgres psql -U app -d appdb -c "
SELECT
  u.name,
  u.id,
  SUM(CASE
    WHEN bt.type = 'accrual' AND (bt.expires_at IS NULL OR bt.expires_at > NOW()) THEN bt.amount
    WHEN bt.type = 'spend' THEN -bt.amount
    ELSE 0
  END) as balance
FROM users u
LEFT JOIN bonus_transactions bt ON u.id = bt.user_id
GROUP BY u.id, u.name
ORDER BY u.name;
"

echo ""
echo "🎯 Готово! Можно начинать тестирование."
echo ""
echo "Доступные пользователи:"
echo "  - Alice:   11111111-1111-1111-1111-111111111111 (баланс: 250)"
echo "  - Bob:     22222222-2222-2222-2222-222222222222 (баланс: 1000)"
echo "  - Charlie: 33333333-3333-3333-3333-333333333333 (баланс: 0)"
