#!/usr/bin/env python3
"""
Migration script to add MealVote and CalendarEvent tables
"""

from app import app
from extensions import db
from models import MealVote, CalendarEvent

def migrate():
    with app.app_context():
        print("Creating new tables...")
        db.create_all()
        print("Migration completed successfully!")
        print("Created tables: meal_votes, calendar_events")

if __name__ == "__main__":
    migrate()
