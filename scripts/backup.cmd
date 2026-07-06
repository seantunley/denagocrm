@echo off
cd /d "C:\Users\Sean Tunley\Documents\denagocrm"
call npx tsx scripts/backup.ts >> backups\backup-log.txt 2>&1
