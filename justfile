# Count source lines of code (excludes tests, mocks, and configs)
count:
    @echo "=== TypeScript (excl. tests) ==="
    @git ls-files '*.ts' | grep -vE '\.(test|spec)\.ts$|/__tests__/|__mocks__' | xargs wc -l | tail -1
    @echo "=== Python (excl. tests) ==="
    @git ls-files '*.py' | grep -vE '(^|/)test|conftest\.py' | xargs wc -l | tail -1

count-ts:
    @git ls-files '*.ts' | grep -vE '\.(test|spec)\.ts$|/__tests__/|__mocks__' | xargs wc -l | tail -1

count-py:
    @git ls-files '*.py' | grep -vE '(^|/)test|conftest\.py' | xargs wc -l | tail -1
