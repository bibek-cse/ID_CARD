# How to apply this update to github.com/bibek-cse/ID_CARD

Run these in your local clone of the repo:

```bash
cd ID_CARD
git pull

# 1. copy the updated files over (keep the folder structure)
cp -r /path/to/ID_CARD_update/{app.py,requirements.txt,README.md,.gitignore} .
cp /path/to/ID_CARD_update/idcard/{app.py,members.csv} idcard/

# 2. remove the real person's photo/signature/card files from the public repo
git rm -r idcard/test idcard/sample_filled.png idcard/layout_debug.png

# 3. commit and push
git add -A
git commit -m "Fix root launcher, add login + hosting support, remove personal test files"
git push
```

Note: deleted files stay in the git history. To remove them from history too, see
https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository
