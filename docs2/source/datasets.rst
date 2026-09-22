Project datasets
================

A dataset supplies training batches and the tensor contracts used by the
editor. Datasets belong to the active project: their definitions, Python
loader and data files are listed in the model manifest and stored inside its
directory. The current training path uses project datasets, not a backend
catalog of Python dataset classes.

Dataset files
-------------

.. code-block:: text

   my-project/
   ├── model.json
   └── datasets/
       └── my-dataset/
           ├── manifest.json
           ├── dataset.json
           ├── dataset.py
           └── data/

``manifest.json`` identifies the dataset and its entrypoints.
``dataset.json`` describes configurable parameters, named tensor slots and
optional class metadata. ``dataset.py`` implements the loader; ``data/`` holds
its local resources. The corresponding entry in
``model.json``'s ``manifest.customDatasets`` declares the exact ID, version and
project-relative directory.

Use the editor's dataset manager to create or edit a dataset. Review the
generated loader before training: a scaffold demonstrates the contract but
does not supply your real data. External source edits are read when you reopen
the project; they are not watched automatically.

All referenced files must remain inside the project. Symlinks and paths that
escape it are unsupported. Prepare data before submission: dataset loaders
must not rely on downloading missing files during training.

Named inputs and targets
------------------------

The definition separates prediction inputs from training targets. For example,
a text dataset can declare:

.. code-block:: json

   {
     "batch": {
       "inputs": {
         "tokens": {"shape": ["B", "T"], "dtype": "int64"},
         "attention_mask": {"shape": ["B", "T"], "dtype": "bool"}
       },
       "targets": {
         "next_tokens": {"shape": ["B", "T"], "dtype": "int64"}
       }
     }
   }

This is the ``batch`` portion of a definition, not a complete dataset file.
``B`` resolves from batch size; other dataset dimension names must resolve from
its declared integer parameters.

Set each top-level Input node's ``binding`` parameter to an input slot name,
such as ``tokens``. Models can use multiple distinct input bindings. A loss
package declares its target source, such as ``batch.targets.next_tokens``;
targets do not need graph Input nodes or edges.

The worker expects flat maps of tensors, with compatible leading batch sizes:

.. code-block:: python

   TrainingBatch(
       inputs={"tokens": tokens, "attention_mask": attention_mask},
       targets={"next_tokens": next_tokens},
   )

The example illustrates the batch shape; the generated ``dataset.py`` provides
imports and the builder contract. Arbitrarily nested Python objects are not
valid tensor slots. A dataset may expose extra slots unused by a particular
model, but every slot used by the graph or objective must exist.

Upload and reuse
----------------

The browser validates the dataset's declarative files, then uploads one complete
archive to the paired backend. Python source runs only in the training worker.
The backend returns an ownership-scoped dataset reference for job submission.
The model package and dataset archive are separate uploads.

Review the backend's upload limit before sending data. The default compressed
archive limit is 64 MiB; separate expanded-size and file-count limits also
apply. Operators can change these limits; see :doc:`training_admin_guide`.
There is no resumable or partial upload. Changing a file requires a complete
archive upload; identical owned content can be reused by digest.

Pairing with a new connection may require uploading the dataset again, even
when the bytes are unchanged. Deleting a local dataset does not delete old
jobs or their immutable backend archives.

The prediction wheel does not include the training dataset. Its input tensor
contracts and selected adapters are enough for inference; see :doc:`python_api`.
