#!/usr/bin/env python3
"""
Database migration script for chat feature enhancements.

Adds new columns to chat_messages table:
- image_url: Store image URLs
- reply_to_id: Enable reply threads
- nickname: Cache nickname at message send time
- deleted_at: Soft delete messages

Creates new user_nicknames table for persistent nickname storage.

Usage:
    python migrate_chat.py

IMPORTANT: Backup your database first!
    cp instance/app.db instance/app.db.backup.$(date +%Y%m%d_%H%M%S)
"""

from app import app, db

def migrate():
    with app.app_context():
        print("🔧 Starting chat feature migration...")

        # Step 1: Add new columns to chat_messages
        print("\n📝 Adding new columns to chat_messages table...")

        try:
            with db.engine.connect() as conn:
                # Check if columns already exist
                result = conn.execute(db.text("PRAGMA table_info(chat_messages)"))
                existing_columns = {row[1] for row in result}

                columns_to_add = {
                    'image_url': 'ALTER TABLE chat_messages ADD COLUMN image_url VARCHAR(500)',
                    'reply_to_id': 'ALTER TABLE chat_messages ADD COLUMN reply_to_id INTEGER REFERENCES chat_messages(id)',
                    'nickname': 'ALTER TABLE chat_messages ADD COLUMN nickname VARCHAR(50)',
                    'deleted_at': 'ALTER TABLE chat_messages ADD COLUMN deleted_at DATETIME'
                }

                for col_name, sql in columns_to_add.items():
                    if col_name not in existing_columns:
                        print(f"  ✅ Adding {col_name}...")
                        conn.execute(db.text(sql))
                        conn.commit()
                    else:
                        print(f"  ⏭️  {col_name} already exists, skipping")

                # Add index for reply_to_id
                print("  ✅ Adding index for reply_to_id...")
                try:
                    conn.execute(db.text("CREATE INDEX IF NOT EXISTS idx_chat_reply ON chat_messages(reply_to_id)"))
                    conn.commit()
                except Exception as e:
                    print(f"  ⚠️  Index might already exist: {e}")

        except Exception as e:
            print(f"❌ Error modifying chat_messages table: {e}")
            return False

        # Step 2: Create user_nicknames table
        print("\n📝 Creating user_nicknames table...")

        try:
            # Check if table exists
            with db.engine.connect() as conn:
                result = conn.execute(db.text(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name='user_nicknames'"
                ))
                if result.fetchone():
                    print("  ⏭️  user_nicknames table already exists, skipping")
                else:
                    # Create table using SQLAlchemy
                    from models import UserNickname
                    db.create_all()
                    print("  ✅ user_nicknames table created")
        except Exception as e:
            print(f"❌ Error creating user_nicknames table: {e}")
            return False

        print("\n✅ Migration completed successfully!")
        print("\n📊 Verification:")

        # Verify migration
        try:
            with db.engine.connect() as conn:
                # Check chat_messages columns
                result = conn.execute(db.text("PRAGMA table_info(chat_messages)"))
                columns = [row[1] for row in result]
                print(f"  chat_messages columns: {', '.join(columns)}")

                # Check user_nicknames table
                result = conn.execute(db.text("PRAGMA table_info(user_nicknames)"))
                columns = [row[1] for row in result]
                print(f"  user_nicknames columns: {', '.join(columns)}")

                # Count existing messages
                result = conn.execute(db.text("SELECT COUNT(*) FROM chat_messages"))
                count = result.scalar()
                print(f"\n  💬 Total messages: {count}")

        except Exception as e:
            print(f"⚠️  Verification warning: {e}")

        return True

if __name__ == "__main__":
    import sys
    import shutil
    from pathlib import Path

    db_path = Path("instance/app.db")

    if not db_path.exists():
        print("❌ Database not found at instance/app.db")
        sys.exit(1)

    # Offer to create backup
    response = input("\n⚠️  This will modify your database. Have you created a backup? (yes/no): ")
    if response.lower() not in ('yes', 'y'):
        print("\n📦 Creating backup...")
        backup_path = db_path.with_suffix(f'.backup')
        shutil.copy(db_path, backup_path)
        print(f"✅ Backup created: {backup_path}")

    # Run migration
    success = migrate()

    if success:
        print("\n🎉 Migration successful! You can now restart your server.")
        sys.exit(0)
    else:
        print("\n❌ Migration failed. Please check the errors above.")
        print("   You can restore from backup if needed.")
        sys.exit(1)
