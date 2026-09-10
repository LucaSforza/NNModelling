# Transformer Spam project

This project uses the prepared Spam-Identification dataset in JSONL form. The
local files are intentionally ignored because they contain the downloaded
dataset:

- `datasets/spamham/data/train.jsonl`: 31,716 examples;
- `datasets/spamham/data/test.jsonl`: 2,000 examples.

Each line contains the message text and its binary label (`0` = `ham`, `1` =
`spam`), together with the source record metadata used by the adapter.

## Obtaining the data

The prepared source dataset is:

<https://huggingface.co/datasets/HansRen1024/Spam-Identification>

Export its `train` and `test` splits as UTF-8 JSONL while preserving the fields
used by `datasets/spamham/dataset.py`: `text`, `label` or `label_text`, and
optionally `subject`, `message`, `message_id` and `date`. Place the resulting
files in `datasets/spamham/data/` with the names shown above.

The records are an Enron spam/ham classification corpus. The underlying public
Enron Email Dataset is documented by Carnegie Mellon University at
<https://www.cs.cmu.edu/~enron/>. Check both sources for their applicable data
and privacy terms before redistributing the messages.
