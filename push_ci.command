#!/bin/bash
cd /Users/anikdua/Documents/Projects/CI-Production
rm -f .git/index.lock
git push origin staging-supabase
echo ""
echo "Push complete!"
