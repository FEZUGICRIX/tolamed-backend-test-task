'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // Удаляем старый глобальный уникальный индекс
    await queryInterface.removeIndex(
      'bonus_transactions',
      'bonus_transactions_request_id_uq',
    );

    // Создаем составной уникальный индекс (user_id, request_id)
    // Это позволяет одинаковые request_id для разных пользователей
    await queryInterface.addIndex('bonus_transactions', ['user_id', 'request_id'], {
      name: 'bonus_transactions_user_id_request_id_uq',
      unique: true,
      where: {
        request_id: { [Sequelize.Op.ne]: null },
      },
    });

    // Добавляем индекс для быстрого поиска просроченных начислений
    await queryInterface.addIndex('bonus_transactions', ['expires_at'], {
      name: 'bonus_transactions_expires_at_idx',
      where: {
        expires_at: { [Sequelize.Op.ne]: null },
      },
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex(
      'bonus_transactions',
      'bonus_transactions_user_id_request_id_uq',
    );
    await queryInterface.removeIndex(
      'bonus_transactions',
      'bonus_transactions_expires_at_idx',
    );

    // Восстанавливаем старый индекс
    await queryInterface.addIndex('bonus_transactions', ['request_id'], {
      name: 'bonus_transactions_request_id_uq',
      unique: true,
    });
  },
};
