import json, gspread, time
from config import config

CLASS_CONFIGS = {}

def load_class_config():
    gc = gspread.service_account(config.json_file_path)
    sh = gc.open_by_url(config.spreadsheet_url)
    ws = sh.worksheet("시트1")

    records = ws.get_all_records()
    configs = {}
    for row in records:
        grade = row["grade"]
        section = row["section"]

        raw_skip = str(row.get("skip_numbers", "")).strip()
        skip_numbers = []
        if raw_skip:
            try:
                skip_numbers = json.loads(raw_skip)
            except json.JSONDecodeError:
                skip_numbers = [int(x.strip()) for x in raw_skip.split(",") if x.strip()]

        configs[(grade, section)] = {
            "end": row["end"],
            "skip_numbers": skip_numbers,
            "pin": row["pin"],
        }
    return configs