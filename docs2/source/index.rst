NNModelling documentation
=========================

NNModelling is a visual editor for neural networks. Build a graph of layers,
inspect tensor shapes and dtypes as you edit, then train it on a separate
backend. A successful training job produces an installable Python wheel for
prediction outside NNModelling.

Start with :doc:`getting_started` to open a project. The :doc:`user_guide`
explains editing and saving; :doc:`training_user_guide` takes you from dataset
selection to a downloaded model.

What you need
-------------

* **To edit:** a browser with writable directory access, or the Linux desktop
  application. Graph editing and tensor inference run locally.
* **To train:** a paired training backend, a project dataset with its data,
  and a graph with a prediction output and training objective.
* **To use a trained model:** the downloaded wheel and a Python environment
  with its dependencies. The editor and training backend are not required.

.. toctree::
   :maxdepth: 2
   :caption: Use NNModelling

   getting_started
   user_guide
   datasets
   training_user_guide
   examples
   troubleshooting

.. toctree::
   :maxdepth: 2
   :caption: Install and operate

   desktop
   training_admin_guide

.. toctree::
   :maxdepth: 2
   :caption: Extend and integrate

   stereotypes
   type_system
   architecture
   python_api
   typescript_api
   license
