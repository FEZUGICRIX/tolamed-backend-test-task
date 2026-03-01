#!/bin/bash

# Скрипт для полной очистки и пересоздания базы данных

echo "🗑️  Останавливаем контейнеры и удаляем volumes..."
docker compose down -v

echo ""
echo "🚀 Запускаем контейнеры заново..."
docker compose up -d

echo ""
echo "⏳ Ждем запуска сервисов..."
sleep 5

echo ""
echo "📦 Применяем миграции..."
docker compose exec api npm run migrate

echo ""
echo "✅ База данных очищена и пересоздана!"
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
